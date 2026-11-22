import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {parseOrcaGraphCandidates} from '../src/c3Concentrated.js';
import {GRAPH_ASSETS,evaluateGraphCycles,type GraphPool,type GraphScanLimits} from '../src/c3Graph.js';

const pk=(b:number)=>new PublicKey(Buffer.alloc(32,b)).toBase58();
const now=Date.parse('2026-11-22T16:00:00.000Z');
const limits:GraphScanLimits={
 sizesUsd:[500],maxAgeMs:15000,maxGapMs:4000,maxSlotSkew:12,
 minLiquidityUsd:50000,maxPathChecks:1000,maxResults:30,
 assumedCostUsd:0.02,maxPoolInputShareBps:500
};
const base:GraphPool={address:pk(1),program:'raydium_amm_v4',
 tokenA:'USDC',tokenB:'SOL',reserveA:'1000000000000',
 reserveB:'14000000000000',feeNumerator:'25',feeDenominator:'10000',
 observedAt:new Date(now).toISOString(),poolSlot:100,vaultSlot:100,
 liquidityUsd:900000,snapshotIntegrity:'bounded_slot_research'};
const clmm:GraphPool={...base,address:pk(2),program:'raydium_clmm',
 reserveA:'0',reserveB:'0',feeNumerator:'0',feeDenominator:'1000000',
 quoteExactInput:(from,raw)=>from==='SOL'
  ?raw/14n*1000n :raw*14n/1000n};
test('C3C parser enforces whitelist, real pool addresses and TVL',()=>{
 const input={data:[
  {address:pk(8),tokenMintA:GRAPH_ASSETS.USDC.mint,
   tokenMintB:GRAPH_ASSETS.SOL.mint,tvlUsdc:125000},
  {address:pk(9),tokenMintA:GRAPH_ASSETS.SOL.mint,
   tokenMintB:GRAPH_ASSETS.USDT.mint,tvlUsdc:80000},
  {address:pk(10),tokenMintA:GRAPH_ASSETS.USDC.mint,
   tokenMintB:pk(30),tvlUsdc:1000000},
  {address:'invalid',tokenMintA:GRAPH_ASSETS.JUP.mint,
   tokenMintB:GRAPH_ASSETS.USDC.mint,tvlUsdc:1000000},
  {address:pk(11),tokenMintA:GRAPH_ASSETS.USDC.mint,
   tokenMintB:GRAPH_ASSETS.USDC.mint,tvlUsdc:1000000}
 ]};
 const result=parseOrcaGraphCandidates(input);
 assert.equal(result.length,2);
 assert.equal(result[0].address,pk(8));
 assert.deepEqual([result[1].tokenA,result[1].tokenB],['SOL','USDT']);
});
test('C3C local CLMM quote participates in chained 2-leg routes without RPC',()=>{
 const seen:Array<{from:string;input:bigint}>=[];
 const pool={...clmm,quoteExactInput:(from:'USDC'|'SOL'|'USDT'|'JUP',raw:bigint)=>{
  seen.push({from,input:raw});
  return from==='SOL'?raw*8n/100n:raw*14n;
 }};
 const r=evaluateGraphCycles([base,pool],limits,now+100);
 assert.equal(r.phase,'C3C');
 assert.equal(r.twoLegCycles,2);
 assert.ok(r.candidates.some(x=>x.poolPath.includes(pk(2))));
 assert.ok(seen.length>0);
 for(const c of r.candidates){
  assert.equal(c.hops[1].amountInRaw,c.hops[0].amountOutRaw);
  assert.equal(c.executable,false);
 }
});
test('C3C refuses concentrator without a working exact-input quote adapter',()=>{
 const r=evaluateGraphCycles([base,{...clmm,quoteExactInput:undefined}],limits,now);
 assert.equal(r.eligiblePools,1);
 assert.equal(r.twoLegCycles,0);
});
test('C3C rejects too-old concentrated-liquidity data and TVL depth limits',()=>{
 const old={...clmm,observedAt:new Date(now-25000).toISOString()};
 assert.equal(evaluateGraphCycles([base,old],limits,now).twoLegCycles,0);
 const thin={...clmm,liquidityUsd:50000};
 const r=evaluateGraphCycles([base,thin],{...limits,maxPoolInputShareBps:50},now);
 assert.ok(r.depthRejected>0);
 assert.equal(r.twoLegCycles,0);
});
test('C3C quote failures never become profitable synthetic prices',()=>{
 const bad={...clmm,quoteExactInput:()=>{throw Error('missing ticks')}};
 const r=evaluateGraphCycles([base,bad],limits,now);
 assert.equal(r.twoLegCycles,0);
 assert.equal(r.positiveIndicative,0);
});
