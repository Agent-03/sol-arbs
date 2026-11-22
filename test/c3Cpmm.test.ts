import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {RAYDIUM_CPMM,CPMM_VAULT_AUTHORITY,SPL_TOKEN_PROGRAM,
 decodeCpmmPool,decodeCpmmConfig,cpmmEffectiveReserves,cpmmAmountOut} from '../src/c3Cpmm.js';
import {GRAPH_ASSETS,evaluateGraphCycles,type GraphPool} from '../src/c3Graph.js';

const id=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const key=(b:Buffer,off:number,address:string)=>new PublicKey(address).toBuffer().copy(b,off);
const disc=(b:Buffer,name:string)=>createHash('sha256')
 .update('account:'+name).digest().subarray(0,8).copy(b,0);
function pool(){
 const b=Buffer.alloc(637);
 disc(b,'PoolState');
 key(b,8,id(17));key(b,72,id(18));key(b,104,id(19));
 key(b,168,GRAPH_ASSETS.USDC.mint);key(b,200,GRAPH_ASSETS.SOL.mint);
 key(b,232,SPL_TOKEN_PROGRAM);key(b,264,SPL_TOKEN_PROGRAM);
 b.writeBigUInt64LE(2500n,341);b.writeBigUInt64LE(1200n,349);
 b.writeBigUInt64LE(1000n,357);b.writeBigUInt64LE(200n,365);
 b.writeBigUInt64LE(300n,397);b.writeBigUInt64LE(400n,405);
 b[389]=0;b[390]=1;
 return b;
}
function config(){
 const b=Buffer.alloc(236);
 disc(b,'AmmConfig');
 b.writeBigUInt64LE(2500n,12);
 b.writeBigUInt64LE(500n,108);
 return b;
}
test('CPMM uses real 637-byte pool and 236-byte fee config layouts',()=>{
 assert.equal(new PublicKey(RAYDIUM_CPMM).toBase58(),RAYDIUM_CPMM);
 assert.equal(new PublicKey(CPMM_VAULT_AUTHORITY).toBase58(),CPMM_VAULT_AUTHORITY);
 const p=decodeCpmmPool(pool());
 assert.equal(p.mintA,GRAPH_ASSETS.USDC.mint);
 assert.equal(p.mintB,GRAPH_ASSETS.SOL.mint);
 assert.equal(p.config,id(17));
 assert.equal(p.vaultA,id(18));
 assert.equal(p.vaultB,id(19));
 assert.equal(p.creatorFeeEnabled,true);
 assert.equal(p.creatorFeeOn,0);
 const f=decodeCpmmConfig(config());
 assert.equal(f.tradeFeeRate,2500n);
 assert.equal(f.creatorFeeRate,500n);
 const reserves=cpmmEffectiveReserves(p,10000000n,20000000n);
 assert.equal(reserves.reserveA,10000000n-2500n-1000n-300n);
 assert.equal(reserves.reserveB,20000000n-1200n-200n-400n);
});
test('CPMM excludes paused pools, future pools, Token-2022 and incompatible layouts',()=>{
 assert.throws(()=>decodeCpmmPool(Buffer.alloc(637)),/layout/);
 assert.throws(()=>decodeCpmmPool(pool().subarray(1)),/layout/);
 assert.throws(()=>decodeCpmmConfig(Buffer.alloc(236)),/layout/);
 const paused=pool();paused[329]=4;
 assert.throws(()=>decodeCpmmPool(paused),/disabled/);
 const future=pool();future.writeBigUInt64LE(9999999999n,373);
 assert.throws(()=>decodeCpmmPool(future),/not yet open/);
 const token22=pool();key(token22,232,'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
 assert.throws(()=>decodeCpmmPool(token22),/Token-2022/);
 const creatorMode=pool();creatorMode[389]=9;
 assert.throws(()=>decodeCpmmPool(creatorMode),/creator fee mode/);
 const f=config();f.writeBigUInt64LE(1000000n,12);
 assert.throws(()=>decodeCpmmConfig(f),/fee config/);
});
test('creator fees on input or output reduce exact-input integer output in correct direction',()=>{
 const input=1000000n,rin=100000000n,rout=100000000n;
 const plain=cpmmAmountOut(input,rin,rout,2500n,0n,0,true);
 const inFee=cpmmAmountOut(input,rin,rout,2500n,1000n,1,true);
 const outFee=cpmmAmountOut(input,rin,rout,2500n,1000n,1,false);
 assert.ok(plain>inFee&&plain>outFee);
 const effective=input-3500n;
 assert.equal(inFee,effective*rout/(rin+effective));
 const tradeOnly=input-2500n;
 const swapped=tradeOnly*rout/(rin+tradeOnly);
 const creator=(swapped*1000n+999999n)/1000000n;
 assert.equal(outFee,swapped-creator);
 assert.equal(cpmmAmountOut(input,rin,rout,2500n,1000n,2,false),inFee);
 assert.equal(cpmmAmountOut(input,rin,rout,2500n,1000n,2,true),outFee);
});
test('mixed AMM V4 and CPMM 2-leg graph chains actual raw outputs and applies per-hop depth gate',()=>{
 const at='2026-11-22T16:00:00.000Z',now=Date.parse(at)+100;
 const a:GraphPool={address:'v4',program:'raydium_amm_v4',tokenA:'USDC',tokenB:'SOL',
  reserveA:'100000000000',reserveB:'1400000000000',
  feeNumerator:'25',feeDenominator:'10000',
  observedAt:at,poolSlot:100,vaultSlot:100,liquidityUsd:500000,
  snapshotIntegrity:'bounded_slot_research'};
 const b:GraphPool={...a,address:'cpmm',program:'raydium_cpmm',
  feeNumerator:'2500',feeDenominator:'1000000',
  creatorFeeRate:'500',creatorFeeOn:1};
 const params={sizesUsd:[500,5000],maxAgeMs:15000,maxGapMs:4000,
  maxSlotSkew:12,minLiquidityUsd:10000,maxPathChecks:10000,
  maxResults:50,assumedCostUsd:0.03};
 const result=evaluateGraphCycles([a,b],params,now);
 assert.equal(result.twoLegCycles,4);
 assert.equal(result.threeLegCycles,0);
 assert.ok(result.candidates.some(v=>v.hops.some(h=>h.program==='raydium_cpmm')));
 for(const cycle of result.candidates)
  assert.equal(cycle.hops[1].amountInRaw,cycle.hops[0].amountOutRaw);
 const gated=evaluateGraphCycles([a,b],{...params,maxPoolInputShareBps:200},now);
 assert.ok(gated.depthRejected>0);
 assert.equal(gated.candidates.filter(x=>x.sizeUsd===5000).length,0);
 assert.ok(gated.candidates.some(x=>x.sizeUsd===500));
});
