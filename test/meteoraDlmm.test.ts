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
  assert.equal(snap.refreshedPoolsLastCycle,4);
  assert.equal(snap.ready,4);
  assert.equal(snap.refreshFailures,0);
  assert.equal(snap.refreshSuccesses,4);
  assert.equal(groups.length,4,'one RPC batch per pool across both provider lanes');
  assert.ok(groups.every(g=>g.length===3),'pool and both bin arrays are fetched together');
  assert.ok(peak>=2&&peak<=4,'bounded concurrent slot-context batches');
  await mon.refresh();
  await mon.refresh();
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
  assert.ok(snap.refreshSuccesses>=19);
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

test('C3D.4.2 one stalled RPC cannot stop subsequent ticks or overlap the same pool',async()=>{
 const sol=new PublicKey(GRAPH_ASSETS.SOL.mint),token=new PublicKey(pk(120));
 const owner=new PublicKey(METEORA_DLMM);
 const pools=Array.from({length:5},(_,i)=>pk(i+30));
 const mints=new Map<string,{owner:PublicKey;data:Buffer}>();
 for(let i=0;i<pools.length;i++)for(const address of [pools[i],pk(i+60),pk(i+90)])
  mints.set(address,{owner,data:Buffer.from([i,13,1])});
 const stalledPool=[...pools].sort()[0];
 let release!:()=>void;
 const stalled=new Promise<void>(resolve=>{release=resolve});
 const received:string[]=[];
 const rpc={
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
   received.push(keys[0].toBase58());
   if(keys[0].toBase58()===stalledPool)await stalled;
   return {context:{slot:100},value:keys.map(k=>{
    const a=mints.get(k.toBase58());
    return a?{data:a.data,owner:a.owner,lamports:100,executable:false,
     rentEpoch:0} as AccountInfo<Buffer>:null;
   })};
  }
 } as unknown as Connection;
 const feed=new MarketDataFeed(rpc);
 const mon=new MeteoraDlmmMonitor(rpc,feed,{
  enabled:true,maxPools:5,maxAgeMs:15000,maxSlotSkew:12,
  refreshMs:8000,concurrency:2,minLiquidityUsd:2500,
  maxArraysPerSide:3,refreshBudget:2,refreshConcurrency:2,
  rpcDeadlineMs:230,reindexDeadlineMs:1000
 },()=>{});
 const entries=(mon as unknown as {entries:Map<string,unknown>}).entries;
 const candidates=(mon as unknown as {candidates:unknown[]}).candidates;
 mon.start();
 try{
  for(let i=0;i<pools.length;i++){
   const address=pools[i],x=pk(i+60),y=pk(i+90);
   const candidate={address,mintA:sol.toBase58(),mintB:token.toBase58(),
    liquidityUsd:50000};
   entries.set(address,{candidate,sdk:{
    lbPair:{tokenXMint:sol,tokenYMint:token},
    tokenX:{publicKey:sol},tokenY:{publicKey:token},
    program:{coder:{accounts:{decode:(name:string)=>name==='lbPair'?
     {tokenXMint:sol,tokenYMint:token}:{lbPair:new PublicKey(address)}}}},
    binArrayBitmapExtension:null
   },binX:[x],binY:[y],bitmap:null,releases:new Map(),
    lastReindexAt:Date.now(),lastVerifiedAt:0,refreshFailures:0});
   candidates.push(candidate);
  }
  await mon.refresh();
  let snap=mon.snapshot();
  assert.equal(snap.refreshCycles,1);
  assert.equal(snap.rpcTimedOut,1,'stalled request trips its own deadline');
  assert.equal(snap.refreshInFlight,0,'timeout frees the scheduling slot');
  assert.equal(snap.outstandingRpcReads,1,'underlying RPC remains per-pool locked');
  assert.equal(snap.refreshSuccesses,1);
  assert.equal(snap.refreshedPoolsLastCycle,2);
  await mon.refresh();
  snap=mon.snapshot();
  assert.equal(snap.refreshCycles,2,'later ticks advance independently');
  assert.equal(snap.refreshAttempts,4,'other pools continue to be verified');
  assert.equal(received.filter(x=>x===stalledPool).length,1,
   'no overlapping request for the timed-out pool');
  assert.equal(snap.outstandingRpcReads,1);
  release();
  await new Promise(resolve=>setTimeout(resolve,10));
  snap=mon.snapshot();
  assert.equal(snap.outstandingRpcReads,0);
  assert.equal(snap.rpcLateSettled,1);
  assert.equal(feed.get(stalledPool),undefined,
   'late response cannot enter quote cache after timeout');
 }finally{release();mon.stop();await feed.stop()}
});

test('C3D.4.2 stuck SDK bin-array recovery cannot block routine account refresh',async()=>{
 const sol=new PublicKey(GRAPH_ASSETS.SOL.mint),token=new PublicKey(pk(120));
 const address=pk(50),x=pk(51),y=pk(52);
 const owner=new PublicKey(METEORA_DLMM);
 const rpc={getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>({
  context:{slot:100},value:keys.map(key=>({
   data:Buffer.from([1,2]),owner,lamports:100,executable:false,rentEpoch:0
  } as AccountInfo<Buffer>))
 })} as unknown as Connection;
 const feed=new MarketDataFeed(rpc);
 const mon=new MeteoraDlmmMonitor(rpc,feed,{
  enabled:true,maxPools:2,maxAgeMs:15000,maxSlotSkew:12,
  refreshMs:8000,concurrency:2,minLiquidityUsd:2500,
  maxArraysPerSide:3,refreshBudget:2,refreshConcurrency:2,
  rpcDeadlineMs:400,reindexDeadlineMs:250,reindexConcurrency:1
 },()=>{});
 const entries=(mon as unknown as {entries:Map<string,unknown>}).entries;
 const candidates=(mon as unknown as {candidates:unknown[]}).candidates;
 const candidate={address,mintA:sol.toBase58(),mintB:token.toBase58(),
  liquidityUsd:50000};
 entries.set(address,{candidate,sdk:{
  lbPair:{tokenXMint:sol,tokenYMint:token},
  tokenX:{publicKey:sol},tokenY:{publicKey:token},
  program:{coder:{accounts:{decode:(name:string)=>name==='lbPair'?
   {tokenXMint:sol,tokenYMint:token}:{lbPair:new PublicKey(address)}}}},
  getBinArrayForSwap:async()=>new Promise<never>(()=>{}),
  binArrayBitmapExtension:null
 },binX:[x],binY:[y],bitmap:null,releases:new Map(),
  lastReindexAt:Date.now(),lastVerifiedAt:0,refreshFailures:0,
  needsReindex:true});
 candidates.push(candidate);
 mon.start();
 try{
  await mon.refresh();
  assert.equal(mon.snapshot().refreshSuccesses,1);
  assert.equal(mon.snapshot().reindexInFlight,1);
  await mon.refresh();
  assert.equal(mon.snapshot().refreshCycles,2);
  assert.ok(mon.snapshot().refreshSuccesses>=2);
  await new Promise(resolve=>setTimeout(resolve,270));
  const snap=mon.snapshot();
  assert.equal(snap.reindexTimedOut,1);
  assert.equal(snap.reindexInFlight,1,
   'timed-out SDK work retains underlying per-pool lock');
  assert.equal(snap.refreshInFlight,0);
  assert.equal(snap.ready,1,'old verified window remains usable');
 }finally{mon.stop();await feed.stop()}
});
