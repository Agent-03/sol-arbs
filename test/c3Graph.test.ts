import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {GRAPH_ASSETS,assetOfMint,evaluateGraphCycles,type GraphPool,type GraphScanLimits} from '../src/c3Graph.js';
import {decodeAmmV4,decodeAmmV4AnyPair} from '../src/ammV4.js';

const at='2026-11-22T16:00:00.000Z',now=Date.parse(at)+100;
const limits:GraphScanLimits={sizesUsd:[5000],maxAgeMs:15000,maxGapMs:4000,
 maxSlotSkew:12,minLiquidityUsd:10000,maxPathChecks:2000,maxResults:50,
 assumedCostUsd:0.03};
const fixed=(id:string,a:GraphPool['tokenA'],b:GraphPool['tokenB'],
 ra:string,rb:string,options:Partial<GraphPool>={}):GraphPool=>({
 address:id,program:'raydium_amm_v4',tokenA:a,tokenB:b,
 reserveA:ra,reserveB:rb,feeNumerator:'25',feeDenominator:'10000',
 observedAt:at,poolSlot:100,vaultSlot:100,liquidityUsd:900000,
 snapshotIntegrity:'bounded_slot_research',...options
});
const pUSDC_SOL=fixed('A','USDC','SOL','1000000000000','14000000000000');
const pSOL_USDT=fixed('B','SOL','USDT','14000000000000','1020000000000');
const pUSDT_USDC=fixed('C','USDT','USDC','1000000000000','1010000000000');
const pSOL_USDC=fixed('D','SOL','USDC','14000000000000','1040000000000');

test('C3B enumerates real chained exact-input 2-leg and 3-leg cycles',()=>{
 const r=evaluateGraphCycles([pUSDC_SOL,pSOL_USDT,pUSDT_USDC,pSOL_USDC],limits,now);
 assert.ok(r.twoLegCycles>=2,'2-leg cycles across distinct SOL/USDC pools');
 assert.ok(r.threeLegCycles>=1,'USDC -> SOL -> USDT -> USDC');
 assert.ok(r.candidates.some(x=>x.tokenPath.join('>')==='USDC>SOL>USDT>USDC'));
 assert.ok(r.candidates.some(x=>x.tokenPath.join('>')==='USDC>SOL>USDC'));
 for(const cycle of r.candidates){
  assert.equal(cycle.hops[0].amountInRaw,cycle.inputUsdcRaw);
  for(let i=1;i<cycle.hops.length;i++){
   assert.equal(cycle.hops[i].amountInRaw,cycle.hops[i-1].amountOutRaw,
    'no multiplication of approximate rates or noncontiguous input');
  }
  assert.equal(cycle.outputUsdcRaw,cycle.hops.at(-1)!.amountOutRaw);
  assert.equal(new Set(cycle.poolPath).size,cycle.poolPath.length);
  assert.equal(cycle.executable,false);
  assert.equal(cycle.classification,'indicative_only');
 }
});
test('C3B never fabricates 3-hop cycles with only SOL/USDC pairs',()=>{
 const r=evaluateGraphCycles([pUSDC_SOL,pSOL_USDC],limits,now);
 assert.ok(r.twoLegCycles>0);
 assert.equal(r.threeLegCycles,0);
 assert.ok(r.candidates.every(c=>c.legs===2));
});
test('C3B stale, insufficient liquidity and excessive slot-skew pools are excluded',()=>{
 const stale=fixed('B','SOL','USDT','14000000000000','1020000000000',
  {observedAt:'2026-11-22T15:59:30Z'});
 const thin={...pUSDT_USDC,liquidityUsd:100};
 const skew={...pSOL_USDC,poolSlot:50,vaultSlot:100};
 const r=evaluateGraphCycles([pUSDC_SOL,stale,thin,skew],limits,now);
 assert.equal(r.eligiblePools,1);
 assert.equal(r.stalePools,3);
 assert.equal(r.twoLegCycles,0);
 assert.equal(r.threeLegCycles,0);
});
test('C3B rejects large inter-pool quote gaps even when each pool is individually recent',()=>{
 const delayed={...pUSDT_USDC,observedAt:'2026-11-22T15:59:55Z'};
 const r=evaluateGraphCycles([pUSDC_SOL,pSOL_USDT,delayed],limits,now);
 assert.equal(r.threeLegCycles,0);
});
test('C3B is strictly bounded under dense graph candidate expansion',()=>{
 const poolList:GraphPool[]=[];
 for(let n=0;n<12;n++){
  const id='SolPool'+n;
  poolList.push(fixed(id,'USDC','SOL','1000000000000','14000000000000'));
  poolList.push(fixed('UsdtPool'+n,'SOL','USDT','14000000000000','1020000000000'));
  poolList.push(fixed('UsdPool'+n,'USDT','USDC','1000000000000','1010000000000'));
 }
 const scan=evaluateGraphCycles(poolList,{...limits,maxPathChecks:35,maxResults:5},now);
 assert.equal(scan.truncated,true);
 assert.equal(scan.pathChecks,35);
 assert.ok(scan.candidates.length<=5);
 assert.equal(scan.mode,'READ_ONLY');
});
test('C3B validates token whitelist by mint, not token ticker aliases',()=>{
 for(const [name,{mint}] of Object.entries(GRAPH_ASSETS)){
  assert.equal(assetOfMint(mint),name);
  assert.equal(new PublicKey(mint).toBase58(),mint);
 }
 assert.equal(assetOfMint('11111111111111111111111111111111'),undefined);
});
test('generic AMM v4 decoder accepts whitelisted non-SOL/USDC pairs while legacy adapter remains strict',()=>{
 const state=Buffer.alloc(752);
 state.writeBigUInt64LE(6n,0);
 state.writeBigUInt64LE(25n,176);
 state.writeBigUInt64LE(10000n,184);
 new PublicKey(GRAPH_ASSETS.SOL.mint).toBuffer().copy(state,400);
 new PublicKey(GRAPH_ASSETS.USDT.mint).toBuffer().copy(state,432);
 const any=decodeAmmV4AnyPair('test-pool',state);
 assert.equal(any.baseMint,GRAPH_ASSETS.SOL.mint);
 assert.equal(any.quoteMint,GRAPH_ASSETS.USDT.mint);
 assert.throws(()=>decodeAmmV4('test-pool',state),/canonical SOL\/USDC/);
});
