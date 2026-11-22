import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type Connection} from '@solana/web3.js';
import {MeteoraDlmmMonitor} from '../src/meteoraDlmm.js';
import {MarketDataFeed} from '../src/marketData.js';
import {evaluateGraphCycles,type GraphPool,type GraphScanLimits,
 replaceDynamicGraphAssets} from '../src/c3Graph.js';
import {METEORA_DLMM,type RegistryPool} from '../src/c3PoolRegistry.js';

const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const at='2026-11-22T16:00:00.000Z',now=Date.parse(at)+100;
const config:GraphScanLimits={baseAsset:'SOL',sizesUsd:[500],sizesSol:[0.05],
 maxAgeMs:15000,maxGapMs:4000,maxSlotSkew:12,
 minLiquidityUsd:2500,maxPathChecks:2000,maxResults:100,assumedCostUsd:0,
 assumedCostSol:0,maxPoolInputShareBps:500};
test('C3D.4 accepts Meteora DLMM as exact local SDK graph edge, never CPMM reserves',()=>{
 const token=pk(120);
 replaceDynamicGraphAssets([{mint:token,decimals:6,symbol:'HOT'}]);
 const common={
  tokenA:'SOL',tokenB:token,
  reserveA:'0',reserveB:'0',feeNumerator:'0',feeDenominator:'1000000',
  observedAt:at,poolSlot:100,vaultSlot:100,liquidityUsd:900000,
  snapshotIntegrity:'bounded_slot_research' as const
 };
 let input:bigint|undefined,from:string|undefined;
 const dlmm:GraphPool={...common,address:pk(121),program:'meteora_dlmm',
  quoteExactInput:(mint,raw)=>{
   from=mint;input=raw;
   return raw*2000n;
  }};
 const raydium:GraphPool={...common,address:pk(122),tokenA:token,tokenB:'SOL',
  reserveA:'100000000000',reserveB:'1500000000000',
  feeNumerator:'25',feeDenominator:'10000',program:'raydium_amm_v4'};
 try{
  const r=evaluateGraphCycles([dlmm,raydium],config,now);
  assert.equal(r.eligiblePools,2);
  assert.ok(r.twoLegCycles>0);
  assert.equal(from,'SOL');
  assert.ok(input!==undefined);
  assert.ok(r.candidates.some(c=>c.hops.some(h=>h.program==='meteora_dlmm')));
  assert.equal(r.candidates[0].hops[1].amountInRaw,
   r.candidates[0].hops[0].amountOutRaw);
  assert.ok(r.candidates.every(c=>c.classification==='indicative_only'&&c.executable===false));
 }finally{replaceDynamicGraphAssets([])}
});
test('C3D.4 DLMM monitor defaults to disabled when the scanner has no explicit enablement',()=>{
 const connection={} as Connection;
 const feed=new MarketDataFeed(connection);
 const mon=new MeteoraDlmmMonitor(connection,feed,{
  enabled:false,maxPools:16,maxAgeMs:15000,maxSlotSkew:12,
  refreshMs:8000,concurrency:3,minLiquidityUsd:2500,maxArraysPerSide:3
 },()=>{});
 mon.start();
 const c:RegistryPool={
  address:pk(122),mintA:pk(121),mintB:pk(120),
  owner:METEORA_DLMM,venue:'meteora',program:'meteora_dlmm',
  liquidityUsd:10000,dexId:'meteora',firstSeenAt:at,lastSeenAt:at,
  lastVerifiedSlot:150,quoteStatus:'not_ready',quoteReason:''
 };
 mon.setCandidates([c]);
 assert.equal(mon.snapshot().tracked,0);
 assert.equal(mon.graphPools().length,0);
 mon.stop();
});
