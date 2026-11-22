import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {MeteoraDlmmMonitor,planDlmmRefresh} from '../src/meteoraDlmm.js';
import {MarketDataFeed} from '../src/marketData.js';
import {evaluateGraphCycles,type GraphPool,type GraphScanLimits,
 replaceDynamicGraphAssets,GRAPH_ASSETS} from '../src/c3Graph.js';
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
 const calls:Array<{input:bigint;from:string}>=[];
 const dlmm:GraphPool={...common,address:pk(121),program:'meteora_dlmm',
  quoteExactInput:(mint,raw)=>{
   calls.push({from:mint,input:raw});
   return raw*2000n;
  }};
 const raydium:GraphPool={...common,address:pk(122),tokenA:token,tokenB:'SOL',
  reserveA:'100000000000',reserveB:'1500000000000',
  feeNumerator:'25',feeDenominator:'10000',program:'raydium_amm_v4'};
 try{
  const r=evaluateGraphCycles([dlmm,raydium],config,now);
  assert.equal(r.eligiblePools,2);
  assert.ok(r.twoLegCycles>0);
  assert.ok(calls.some(c=>c.from==='SOL'&&c.input===50000000n));
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

test('C3D.4.1 DLMM refresh plan prioritizes unverified pools but never starves ready routes',()=>{
 const now=1_000_000;
 const items=[
  {address:'new',lastVerifiedAt:0,retryAfter:0,ready:false,solPair:true},
  {address:'old',lastVerifiedAt:now-10000,retryAfter:0,ready:true,solPair:false},
  {address:'recent',lastVerifiedAt:now-1000,retryAfter:0,ready:false,solPair:true},
  {address:'backoff',lastVerifiedAt:0,retryAfter:now+1000,ready:false,solPair:true}
 ];
 const first=planDlmmRefresh(items,now,2);
 assert.deepEqual(first,['new','old'],'old ready pool outranks fresher unready pool');
 const second=planDlmmRefresh(items.map(x=>x.address==='new'?
  {...x,lastVerifiedAt:now}:x),now+600,2);
 assert.deepEqual(second,['old','recent'],'newest recovered pool gives others a turn');
 assert.ok(!first.includes('backoff'));
 assert.deepEqual(planDlmmRefresh(items,now,10).length,3);
 assert.throws(()=>planDlmmRefresh(items,now,0),/budget/);
});

test('C3D.4.1 concurrent per-pool batches refresh all DLMM slots without relaxing freshness limits',async()=>{
 const count=16,sol=new PublicKey(GRAPH_ASSETS.SOL.mint),token=new PublicKey(pk(120));
 const locations=new Map<string,{owner:PublicKey;data:Buffer}>();
 const poolAddresses:string[]=[];
 let inFlight=0,peak=0,failOnce=false;
 const groups:string[][]=[];
 for(let i=0;i<count;i++){
  const pool=pk(i+20),a=pk(i+50),b=pk(i+80);
  poolAddresses.push(pool);
  for(const address of [pool,a,b])locations.set(address,{
   owner:new PublicKey(METEORA_DLMM),data:Buffer.from([2,i,5])
  });
 }
 const rpc={
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
   inFlight++;peak=Math.max(peak,inFlight);
   groups.push(keys.map(x=>x.toBase58()));
   await new Promise(resolve=>setTimeout(resolve,5));
   inFlight--;
   if(failOnce&&keys[0].toBase58()===poolAddresses[0]){
    failOnce=false;throw Error('transient provider timeout');
   }
   return {context:{slot:8888},value:keys.map(x=>{
    const item=locations.get(x.toBase58());
    return item?{owner:item.owner,data:item.data,lamports:1,
     executable:false,rentEpoch:0} as AccountInfo<Buffer>:null;
   })};
  }
 } as unknown as Connection;
 const feed=new MarketDataFeed(rpc);
 const mon=new MeteoraDlmmMonitor(rpc,feed,{
  enabled:true,maxPools:16,maxAgeMs:15000,maxSlotSkew:12,refreshMs:8000,
  concurrency:3,minLiquidityUsd:2500,maxArraysPerSide:3,
  refreshBudget:8,refreshConcurrency:4
 },()=>{});
 const entries=(mon as unknown as {entries:Map<string,unknown>}).entries;
 const monitor=(mon as unknown as {candidates:unknown[]});
 mon.start();
 try{
  for(let i=0;i<count;i++){
   const address=poolAddresses[i],a=pk(i+50),b=pk(i+80);
   const sdk={
    lbPair:{tokenXMint:sol,tokenYMint:token},
    tokenX:{publicKey:sol},tokenY:{publicKey:token},
    program:{coder:{accounts:{decode:(type:string)=>type==='lbPair'?
     {tokenXMint:sol,tokenYMint:token}:{lbPair:new PublicKey(address)}}}},
    binArrayBitmapExtension:null
   };
   const candidate={address,mintA:sol.toBase58(),mintB:token.toBase58(),liquidityUsd:50000};
   entries.set(address,{candidate,sdk,binX:[a],binY:[b],bitmap:null,
    releases:new Map(),lastReindexAt:Date.now(),lastVerifiedAt:0,
    refreshFailures:0});
   monitor.candidates.push(candidate);
  }
  let snap=mon.snapshot();
  assert.equal(snap.effectiveRefreshMs,3750,
   'old 8000ms env setting auto-adjusts for 16 pools and 15-second freshness');
  assert.equal(snap.ready,0);
  await mon.refresh();
  snap=mon.snapshot();
  assert.equal(snap.refreshedPoolsLastCycle,8);
  assert.equal(snap.ready,8);
  assert.equal(snap.refreshFailures,0);
  assert.equal(snap.refreshSuccesses,8);
  assert.equal(groups.length,8,'one RPC batch per pool across both provider lanes');
  assert.ok(groups.every(g=>g.length===3),'pool and both bin arrays are fetched together');
  assert.ok(peak>=2&&peak<=4,'bounded concurrent slot-context batches');
  await mon.refresh();
  snap=mon.snapshot();
  assert.equal(snap.ready,16,'age-based fairness brings remaining pools into graph');
  assert.equal(snap.refreshSuccesses,16);
  assert.equal(snap.reasonCounts.component_age??0,0);
  assert.ok(snap.oldestAccountAgeMs!==null&&snap.oldestAccountAgeMs<15000);
  assert.equal(snap.recoveryCount,0);
  // A failed per-pool fetch must not abort the other RPC workers.
  failOnce=true;
  const bad=entries.get(poolAddresses[0]) as {
   lastVerifiedAt:number;retryAfter:number;refreshFailures:number
  };
  // Simulate an account whose bytes are unchanged but whose last RPC
  // verification is old. The scheduler must prioritize its actual cache age.
  const sample=locations.get(poolAddresses[0])!;
  feed.ingest(poolAddresses[0],{owner:sample.owner,data:sample.data,lamports:1,
   executable:false,rentEpoch:0},8888,'rpc_poll',Date.now()-14000);
  await mon.refresh();
  snap=mon.snapshot();
  assert.equal(snap.refreshFailures,1);
  assert.equal(snap.backoffPools,1);
  assert.ok(snap.refreshSuccesses>=23);
  assert.equal(bad.refreshFailures,1);
  assert.ok(bad.retryAfter>Date.now());
  // Simulate cooldown expiry; the next successful read clears the error.
  bad.retryAfter=0;
  await mon.refresh();
  snap=mon.snapshot();
  assert.equal(bad.refreshFailures,0);
  assert.equal(snap.backoffPools,0);
  assert.equal(snap.status,'ready');
 }finally{mon.stop();await feed.stop()}
});
