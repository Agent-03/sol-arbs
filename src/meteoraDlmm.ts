import {PublicKey,type Connection} from '@solana/web3.js';
import {createRequire} from 'node:module';
import type * as MeteoraTypes from '@meteora-ag/dlmm';
import type {BinArrayAccount} from '@meteora-ag/dlmm';
// Published SDK ESM entry cannot load its Anchor CommonJS directory imports
// under NodeNext. Resolve the package's supported CommonJS entry explicitly.
// Its CJS export is the DLMM class itself, not {default: DLMM}.
const DLMM=createRequire(import.meta.url)('@meteora-ag/dlmm') as typeof MeteoraTypes.default.default;
type DLMM=InstanceType<typeof MeteoraTypes.default.default>;
import BN from 'bn.js';
import {METEORA_DLMM,type RegistryPool} from './c3PoolRegistry.js';
import {GRAPH_ASSETS,assetOfMint,type GraphPool} from './c3Graph.js';
import {validateLocalComponents} from './localWhirlpool.js';
import type {MarketDataFeed,MarketObservation} from './marketData.js';
import {withRpcPriority,type RpcTiming} from './rpcPriority.js';

export type DlmmPoolReadiness={
 address:string;pair:string;status:'ready'|'warming'|'not_ready';
 reason?:string;quoteFailure?:string;binArrays:number;oldestAgeMs:number|null;
 slotGap:number|null;lastQuoteAt?:string;lastVerifiedAt?:string;
 refreshFailures:number;refreshing:boolean;notReadyForMs:number|null;
 refreshDurationMs:number|null;reindexing:boolean;readTimedOut:boolean;
 lastTimeoutAt?:string;readySince?:string;continuousReadyMs:number|null;
 rpcQueueWaitMs?:number;rpcTransportMs?:number;rpcTimeoutCause?:string;
 windowBinIndex?:number;
};
export type DlmmHealth={
 status:'disabled'|'warming'|'ready'|'partial_error'|'stopped';
 tracked:number;ready:number;bootstrapAttempts:number;bootstrapFailures:number;
 localQuotes:number;quoteFailures:number;verifiedAccountRefreshes:number;
 pending:number;lastRefreshAt?:string;perPool:DlmmPoolReadiness[];errors:string[];
 refreshCycles:number;refreshAttempts:number;refreshSuccesses:number;
 refreshFailures:number;refreshInFlight:number;peakRefreshInFlight:number;
 refreshedPoolsLastCycle:number;refreshBudget:number;refreshConcurrency:number;
 effectiveRefreshMs:number;oldestAccountAgeMs:number|null;
 reasonCounts:Record<string,number>;recoveryCount:number;backoffPools:number;
 schedulerTicks:number;dispatchedLastTick:number;skippedInFlight:number;
 skippedCapacity:number;skippedBackoff:number;outstandingRpcReads:number;
 oldestOutstandingRpcMs:number;rpcDeadlineMs:number;rpcTimedOut:number;
 rpcLateSettled:number;partialRefreshes:number;refreshDurationMsP95:number;
 refreshDurationMsAvg:number;reindexInFlight:number;reindexAttempts:number;
 reindexSuccesses:number;reindexFailures:number;reindexTimedOut:number;
 bootstrapInFlight:number;
 bootstrapConcurrency:number;bootstrapDeferred:number;
 bootstrapPhysicalInFlight:number;
 windowShiftReindexes:number;periodicReindexesRemoved:boolean;
 queueDeadlineExceeded:number;transportDeadlineExceeded:number;
};
type Candidate={address:string;mintA:string;mintB:string;liquidityUsd:number};
type Entry={
 candidate:Candidate;sdk:DLMM;binX:string[];binY:string[];bitmap:string|null;
 releases:Map<string,()=>void>;lastReindexAt:number;
 lastQuoteAt?:string;quoteFailure?:string;needsReindex?:boolean;
 lastVerifiedAt?:number;lastAttemptAt?:number;retryAfter?:number;refreshing?:boolean;
 refreshFailures?:number;notReadySince?:number;lastReady?:boolean;
 refreshDurationMs?:number;readTimedOut?:boolean;lastTimeoutAt?:number;
 readySince?:number;reindexing?:boolean;reindexRetryAfter?:number;
 reindexFailures?:number;
 windowBinIndex?:number;rpcQueueWaitMs?:number;rpcTransportMs?:number;
 rpcTimeoutCause?:string;rpcPhase?:'queued'|'transport'|'completed';
};
type Observed={data:Buffer;verifiedAt:number;verifiedSlot:number;owner:string};
const ctxPrefix='c3dlmm:';
const core=(obs:MarketObservation):Observed=>({
 data:Buffer.from(obs.data),verifiedAt:obs.verifiedAt,
 verifiedSlot:obs.verifiedSlot,owner:obs.owner
});
const message=(error:unknown)=>String(error).slice(0,190);
const unique=(addresses:readonly string[])=>[...new Set(addresses)];
export type DlmmRefreshPlanItem={
 address:string;lastVerifiedAt:number;retryAfter:number;ready:boolean;
 solPair:boolean;
};
/** Prioritize old verification timestamps, then readiness and wSOL routes.
 * Fairness comes from age: no pool is permanently displaced by a stale
 * high-priority candidate. Retry cooldown prevents a failing RPC starving
 * the other tracked pools.
 */
export function planDlmmRefresh(
 items:readonly DlmmRefreshPlanItem[],now:number,budget:number
):string[]{
 if(!Number.isSafeInteger(budget)||budget<1)throw Error('Invalid DLMM refresh budget');
 const eligible=items.filter(x=>x.retryAfter<=now);
 const urgency=(x:DlmmRefreshPlanItem)=>
  (x.lastVerifiedAt>0?now-x.lastVerifiedAt:Number.MAX_SAFE_INTEGER/4)+
   (!x.ready?Math.min(1500,Math.max(0,now-x.lastVerifiedAt)*0.12):0)+
   (x.solPair?250:0);
 return eligible.sort((a,b)=>urgency(b)-urgency(a)||
  a.address.localeCompare(b.address)).slice(0,budget).map(x=>x.address);
}


/** Local exact-input Meteora DLMM quotes.
 * The official SDK supplies dynamic fees, bin traversal and integer rounding.
 * The quote path is synchronous and uses only feed-verified account bytes:
 * no remote quotes, no third-party mid prices, no wallet or transaction code.
 */
export class MeteoraDlmmMonitor{
 private readonly entries=new Map<string,Entry>();
 private candidates:Candidate[]=[];
 private readonly pending=new Set<string>();
 private running=false;
 private timer?:ReturnType<typeof setInterval>;
 private eventRelease?:()=>void;
 private status:DlmmHealth['status']='disabled';
 private errors:string[]=[];
 private bootstrapAttempts=0;private bootstrapFailures=0;
 private localQuotes=0;private quoteFailures=0;
 private verifiedAccountRefreshes=0;
 private refreshCycles=0;private refreshAttempts=0;private refreshSuccesses=0;
 private refreshFailures=0;private refreshInFlight=0;private peakRefreshInFlight=0;
 private refreshedPoolsLastCycle=0;private recoveryCount=0;
 private readonly bootstrapRetry=new Map<string,{until:number;failures:number}>();
 private readonly bootstrapPhysical=new Map<string,Promise<unknown>>();
 private readonly rpcReads=new Map<string,{entry:Entry;startedAt:number;promise:Promise<void>;timedOut:boolean}>();
 private readonly reindexes=new Map<string,{entry:Entry;startedAt:number;promise:Promise<void>}>();
 private schedulerTicks=0;private dispatchedLastTick=0;
 private skippedInFlight=0;private skippedCapacity=0;private skippedBackoff=0;
 private rpcTimedOut=0;private rpcLateSettled=0;private partialRefreshes=0;
 private reindexAttempts=0;private reindexSuccesses=0;private reindexFailures=0;
 private reindexTimedOut=0;
 private bootstrapDeferred=0;private windowShiftReindexes=0;
 private queueDeadlineExceeded=0;private transportDeadlineExceeded=0;
 private readonly timings:number[]=[];
 private readonly rpcDeadlineMs:number;private readonly reindexDeadlineMs:number;
 private readonly maxOutstandingRpc:number;private readonly maxOutstandingReindex:number;
 private readonly refreshBudget:number;private readonly refreshConcurrency:number;
 private readonly effectiveRefreshMs:number;
 private readonly reindexConcurrency:number;
 private readonly bootstrapConcurrency:number;
 private lastRefreshAt?:string;
 constructor(private readonly rpc:Connection,private readonly feed:MarketDataFeed,
  private readonly opts:{
   enabled:boolean;maxPools:number;maxAgeMs:number;maxSlotSkew:number;
   refreshMs:number;concurrency:number;minLiquidityUsd:number;maxArraysPerSide:number;
   refreshBudget?:number;refreshConcurrency?:number;
   rpcDeadlineMs?:number;reindexDeadlineMs?:number;reindexConcurrency?:number;
   bootstrapConcurrency?:number;
  },
  private readonly onChange:()=>void){
  if(!Number.isSafeInteger(opts.maxPools)||opts.maxPools<1||opts.maxPools>40||
   !Number.isSafeInteger(opts.concurrency)||opts.concurrency<1||opts.concurrency>8||
   !Number.isSafeInteger(opts.maxAgeMs)||opts.maxAgeMs<1000||
   !Number.isSafeInteger(opts.maxSlotSkew)||opts.maxSlotSkew<0||
   !Number.isSafeInteger(opts.refreshMs)||opts.refreshMs<2500||
   !Number.isSafeInteger(opts.maxArraysPerSide)||opts.maxArraysPerSide<1||
   opts.maxArraysPerSide>8)throw Error('Invalid Meteora DLMM quote monitor limits');
  this.refreshBudget=opts.refreshBudget??8;
  this.refreshConcurrency=opts.refreshConcurrency??4;
  if(!Number.isSafeInteger(this.refreshBudget)||this.refreshBudget<1||
   this.refreshBudget>32||!Number.isSafeInteger(this.refreshConcurrency)||
   this.refreshConcurrency<1||this.refreshConcurrency>12)
   throw Error('Invalid DLMM per-tick refresh budget');
  this.rpcDeadlineMs=opts.rpcDeadlineMs??Math.min(6000,Math.max(1500,
   Math.floor(opts.maxAgeMs*0.4)));
  this.reindexDeadlineMs=opts.reindexDeadlineMs??Math.max(2500,Math.min(12000,
   opts.maxAgeMs-1000));
  const reindexConcurrency=opts.reindexConcurrency??2;
  this.bootstrapConcurrency=opts.bootstrapConcurrency??1;
  if(!Number.isSafeInteger(this.rpcDeadlineMs)||this.rpcDeadlineMs<200||
   this.rpcDeadlineMs>=opts.maxAgeMs||
   !Number.isSafeInteger(this.reindexDeadlineMs)||this.reindexDeadlineMs<200||
   !Number.isSafeInteger(reindexConcurrency)||reindexConcurrency<1||
   reindexConcurrency>4||
   !Number.isSafeInteger(this.bootstrapConcurrency)||
   this.bootstrapConcurrency<1||this.bootstrapConcurrency>3)
   throw Error('Invalid C3D.4.3 RPC/background concurrency settings');
  this.maxOutstandingRpc=Math.min(opts.maxPools,
   Math.max(this.refreshConcurrency,this.refreshConcurrency*2));
  this.maxOutstandingReindex=Math.min(opts.maxPools,reindexConcurrency*2);
  this.reindexConcurrency=reindexConcurrency;
  // Refresh every pool at least twice per maxAge window *at target latency*
  // even if the user's existing .env retains C3D4_DLMM_REFRESH_MS=8000.
  // No freshness/slot limits are relaxed to make metrics look better.
  const rounds=Math.ceil(opts.maxPools/this.refreshBudget);
  this.effectiveRefreshMs=Math.min(opts.refreshMs,Math.max(1000,
   Math.floor(opts.maxAgeMs/(Math.max(1,rounds)*2))));
 }
 private report(error:string){
  this.errors.unshift(error);
  this.errors=this.errors.slice(0,10);
 }
 start(){
  if(this.running||!this.opts.enabled)return;
  this.running=true;this.status='warming';
  this.eventRelease=this.feed.onUpdate(update=>{
   if(!this.running||!update.affectedPools.some(x=>x.startsWith(ctxPrefix)))return;
   this.onChange();
  });
  this.timer=setInterval(()=>void this.refresh(),this.effectiveRefreshMs);
 }
 setCandidates(rows:readonly RegistryPool[]){
  if(!this.running)return;
  const sol=GRAPH_ASSETS.SOL.mint;
  const eligible=rows
   .filter(x=>x.program==='meteora_dlmm'&&x.owner===METEORA_DLMM&&
    x.liquidityUsd>=this.opts.minLiquidityUsd&&
    assetOfMint(x.mintA)!==undefined&&assetOfMint(x.mintB)!==undefined)
   .map(x=>({address:x.address,mintA:x.mintA,mintB:x.mintB,
    liquidityUsd:x.liquidityUsd}))
   .sort((a,b)=>Number(b.mintA===sol||b.mintB===sol)-
    Number(a.mintA===sol||a.mintB===sol)||
    b.liquidityUsd-a.liquidityUsd);
  const found=new Map(eligible.map(c=>[c.address,c]));
  // Preserve selected verified pool identities across liquidity rank changes.
  // New hints fill vacancies but cannot churn existing subscriptions every refresh.
  const retained=this.candidates.flatMap(c=>{
   const current=found.get(c.address);
   return current?[current]:[];
  });
  const inUse=new Set(retained.map(c=>c.address));
  this.candidates=[...retained,...eligible.filter(c=>!inUse.has(c.address))]
   .slice(0,this.opts.maxPools);
  const allowed=new Set(this.candidates.map(x=>x.address));
  // Retained pools keep their active watches but receive updated, verified
  // liquidity estimates and mint metadata from the current registry snapshot.
  for(const candidate of this.candidates){
   const entry=this.entries.get(candidate.address);
   if(entry)entry.candidate=candidate;
  }
  for(const address of this.entries.keys())
   if(!allowed.has(address))this.forget(address);
  for(const key of this.bootstrapRetry.keys())if(!allowed.has(key))
   this.bootstrapRetry.delete(key);
  void this.refresh();
 }
 private forget(address:string){
  const entry=this.entries.get(address);if(!entry)return;
  entry.releases.forEach(release=>release());
  entry.releases.clear();this.entries.delete(address);
  this.feed.clearDependencies(ctxPrefix+address);
  // Outstanding RPC work remains locked until the actual transport settles.
  // Its late result cannot reattach this removed pool.
 }
 private arrays(entry:Entry){
  return unique([...entry.binX,...entry.binY]);
 }
 private observed(address:string):Observed|null{
  const obs=this.feed.get(address);
  return obs?core(obs):null;
 }
 private async updateArrays(entry:Entry,stillValid:()=>boolean=()=>true):Promise<void>{
  const sdk=entry.sdk;
  if(!stillValid())throw Error('bin_window_superseded');
  const latest=this.observed(entry.candidate.address);
  if(latest){
   sdk.lbPair=sdk.program.coder.accounts.decode('lbPair',latest.data) as typeof sdk.lbPair;
   if(entry.bitmap&&sdk.binArrayBitmapExtension){
    const bitmap=this.observed(entry.bitmap);
    if(bitmap)sdk.binArrayBitmapExtension.account=sdk.program.coder.accounts.decode(
     'binArrayBitmapExtension',bitmap.data) as typeof sdk.binArrayBitmapExtension.account;
   }
  }
  const x=await sdk.getBinArrayForSwap(true,this.opts.maxArraysPerSide);
  if(!stillValid())throw Error('bin_window_superseded');
  const y=await sdk.getBinArrayForSwap(false,this.opts.maxArraysPerSide);
  if(!stillValid())throw Error('bin_window_superseded');
  const binX=unique(x.map(a=>a.publicKey.toBase58()));
  const binY=unique(y.map(a=>a.publicKey.toBase58()));
  if(!binX.length||!binY.length)throw Error('bin_arrays_missing_direction');
  const bitmap=sdk.binArrayBitmapExtension?.publicKey.toBase58()??null;
  const all=unique([entry.candidate.address,...binX,...binY,
   ...(bitmap?[bitmap]:[])]);
  const newReleases=new Map<string,()=>void>();
  try{
   // Keep the old window live while the replacement's on-chain state is
   // being verified. A slow or timed-out SDK reindex never tears it down.
   for(const address of all)if(!entry.releases.has(address)){
    this.feed.expectOwner(address,METEORA_DLMM);
    newReleases.set(address,this.feed.watch(address));
   }
   if(!stillValid())throw Error('bin_window_superseded');
   await this.feed.reconcile(all,'rpc_bootstrap',this.reindexDeadlineMs);
   if(!stillValid())throw Error('bin_window_superseded');
   for(const [address,release] of entry.releases)if(!all.includes(address)){
    release();entry.releases.delete(address);
   }
   for(const [address,release] of newReleases)entry.releases.set(address,release);
   newReleases.clear();
   this.feed.setDependencies(ctxPrefix+entry.candidate.address,all);
   entry.binX=binX;entry.binY=binY;entry.bitmap=bitmap;
   entry.lastReindexAt=Date.now();entry.needsReindex=false;
   entry.windowBinIndex=this.poolBinArrayIndex(entry)??undefined;
   this.verifiedAccountRefreshes++;
  }finally{
   for(const release of newReleases.values())release();
  }
 }
 private trackBootstrapWork<T>(address:string,work:Promise<T>):Promise<T>{
  this.bootstrapPhysical.set(address,work);
  void work.then(()=>{
   if(this.bootstrapPhysical.get(address)===work)this.bootstrapPhysical.delete(address);
  },()=>{
   if(this.bootstrapPhysical.get(address)===work)this.bootstrapPhysical.delete(address);
  });
  return work;
 }
 private async bootstrap(candidate:Candidate){
  if(!this.running||this.entries.has(candidate.address)||
   this.pending.has(candidate.address)||this.bootstrapPhysical.has(candidate.address))return;
  this.pending.add(candidate.address);this.bootstrapAttempts++;
  let entry:Entry|undefined;
  try{
   const sdk=await this.withDeadline(
    this.trackBootstrapWork(candidate.address,
     DLMM.create(this.rpc,new PublicKey(candidate.address))),
    this.reindexDeadlineMs,'dlmm_bootstrap_timeout');
   if(!this.running)return;
   const a=sdk.lbPair.tokenXMint.toBase58(),b=sdk.lbPair.tokenYMint.toBase58();
   if(!((a===candidate.mintA&&b===candidate.mintB)||
     (a===candidate.mintB&&b===candidate.mintA)))throw Error('mint_pair_mismatch');
   if(!assetOfMint(a)||!assetOfMint(b))throw Error('mint_left_active_universe');
   // Exact fee transfer semantics are currently supported for classic SPL.
   const tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
   if(sdk.tokenX.owner.toBase58()!==tokenProgram||
      sdk.tokenY.owner.toBase58()!==tokenProgram)
    throw Error('token_extension_quote_not_enabled');
   entry={candidate,sdk,binX:[],binY:[],bitmap:null,
    releases:new Map(),lastReindexAt:0};
   let active=true;
   try{
    await this.withDeadline(this.trackBootstrapWork(candidate.address,
     this.updateArrays(entry,()=>active&&this.running&&
     this.candidates.some(c=>c.address===candidate.address))),
     this.reindexDeadlineMs,'dlmm_bootstrap_arrays_timeout');
   }finally{active=false}
   if(!this.running||!this.candidates.some(x=>x.address===candidate.address)){
    entry.releases.forEach(release=>release());this.feed.clearDependencies(ctxPrefix+candidate.address);
    return;
   }
   this.entries.set(candidate.address,entry);
   this.errors=this.errors.filter(x=>!x.startsWith(candidate.address+':'));
   this.bootstrapRetry.delete(candidate.address);
   this.onChange();
  }catch(error){
   entry?.releases.forEach(release=>release());
   this.feed.clearDependencies(ctxPrefix+candidate.address);
   this.bootstrapFailures++;
   const previous=this.bootstrapRetry.get(candidate.address)?.failures??0;
   const failures=previous+1;
   this.bootstrapRetry.set(candidate.address,{failures,
    until:Date.now()+Math.min(30000,1500*Math.pow(2,Math.min(4,failures-1)))});
   this.report(candidate.address+': '+message(error));
  }finally{this.pending.delete(candidate.address)}
 }
 /** Starts bounded background bootstrap without waiting for every remote SDK
  * RPC read before refreshing already-quotable pools.
  */
 private launchBootstraps(){
  const free=Math.max(0,this.bootstrapConcurrency-
   new Set([...this.pending,...this.bootstrapPhysical.keys()]).size);
  if(!free)return;
  const at=Date.now();
  const queued=this.candidates.filter(x=>!this.entries.has(x.address)&&
   !this.pending.has(x.address)&&!this.bootstrapPhysical.has(x.address)&&
   (this.bootstrapRetry.get(x.address)?.until??0)<=at);
  this.bootstrapDeferred+=Math.max(0,queued.length-free);
  for(const row of queued.slice(0,free)){
   void withRpcPriority('background',()=>this.bootstrap(row)).then(()=>{
    if(this.running&&this.candidates.some(x=>x.address===row.address))
     this.onChange();
   });
  }
 }
 private refreshAddresses(entry:Entry):string[]{
  return unique([entry.candidate.address,...this.arrays(entry),
   ...(entry.bitmap?[entry.bitmap]:[])]);
 }
 private oldestVerifiedAt(entry:Entry):number{
  const addresses=this.refreshAddresses(entry);
  if(!addresses.length)return 0;
  let oldest=Number.MAX_SAFE_INTEGER;
  for(const address of addresses){
   const observation=this.feed.get(address);
   if(!observation)return 0;
   oldest=Math.min(oldest,observation.verifiedAt);
  }
  return oldest===Number.MAX_SAFE_INTEGER?0:oldest;
 }
 /** A bin array owns 70 adjacent bins. A different active-bin array
  * invalidates the original swap-window selection. Moving *inside* the
  * same array does not justify expensive SDK reindex RPC.
  */
 private poolBinArrayIndex(entry:Entry):number|null{
  const info=this.observed(entry.candidate.address);
  if(!info)return null;
  try{
   const pool=entry.sdk.program.coder.accounts.decode('lbPair',info.data) as
    typeof entry.sdk.lbPair;
   const value=Number(pool.activeId?.toString());
   return Number.isSafeInteger(value)?Math.floor(value/70):null;
  }catch{return null}
 }
 private isSolPair(entry:Entry):boolean{
  const sol=GRAPH_ASSETS.SOL.mint;
  return entry.candidate.mintA===sol||entry.candidate.mintB===sol;
 }
 private withDeadline<T>(work:Promise<T>,timeoutMs:number,label:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<T>((_,reject)=>{
   timer=setTimeout(()=>reject(new Error(label)),timeoutMs);
  });
  return Promise.race([work,deadline]).finally(()=>{
   if(timer)clearTimeout(timer);
  });
 }
 /** Per-pool lock persists until the *underlying* RPC promise settles even
  * after the logical deadline. Late account reads are rejected by the feed.
  * This prevents overlapping reads or an unbounded timed-out RPC backlog.
  */
 private async refreshEntry(entry:Entry):Promise<void>{
  const address=entry.candidate.address;
  if(!this.running||this.entries.get(address)!==entry||this.rpcReads.has(address))
   return;
  const started=Date.now(),wasReady=this.state(entry).ok;
  this.refreshAttempts++;this.refreshInFlight++;
  entry.refreshing=true;entry.readTimedOut=false;entry.lastAttemptAt=started;
  this.peakRefreshInFlight=Math.max(this.peakRefreshInFlight,this.refreshInFlight);
  entry.rpcPhase='queued';
  const timing=(event:RpcTiming)=>{
   if(event.phase==='started'){
    entry.rpcPhase='transport';
    entry.rpcQueueWaitMs=event.queueWaitMs;
   }else{
    entry.rpcPhase='completed';
    entry.rpcTransportMs=event.transportMs;
   }
  };
  const work=withRpcPriority('quotes',()=>this.feed.reconcile(
   this.refreshAddresses(entry),'rpc_reconcile',this.rpcDeadlineMs),timing);
  const record={entry,startedAt:started,promise:work,timedOut:false};
  this.rpcReads.set(address,record);
  void work.then(()=>{
   if(record.timedOut)this.rpcLateSettled++;
   if(this.rpcReads.get(address)===record)this.rpcReads.delete(address);
  },()=>{
   if(record.timedOut)this.rpcLateSettled++;
   if(this.rpcReads.get(address)===record)this.rpcReads.delete(address);
  });
  let deadlineTimer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{
   deadlineTimer=setTimeout(()=>{
    record.timedOut=true;
    reject(new Error('rpc_refresh_deadline_exceeded'));
   },this.rpcDeadlineMs);
  });
  try{
   await Promise.race([work,timeout]);
   if(!this.running||this.entries.get(address)!==entry)return;
   const verdict=this.state(entry);
   entry.lastVerifiedAt=this.oldestVerifiedAt(entry);
   entry.refreshFailures=0;entry.retryAfter=0;
   entry.rpcTimeoutCause=undefined;
   const currentWindow=this.poolBinArrayIndex(entry);
   if(currentWindow!==null&&entry.windowBinIndex!==undefined&&
      currentWindow!==entry.windowBinIndex&&!entry.needsReindex){
    entry.needsReindex=true;this.windowShiftReindexes++;
   }
   entry.quoteFailure=undefined;
   if(verdict.ok){
    this.refreshSuccesses++;this.verifiedAccountRefreshes++;
    this.errors=this.errors.filter(x=>!x.startsWith(address+': refresh '));
   }else{
    // HTTP 200 isn't sufficient if any oracle/bin account is missing,
    // stale or across an unacceptable slot skew.
    this.partialRefreshes++;
    entry.quoteFailure='incomplete_snapshot:'+(verdict.reason??'unknown');
    entry.retryAfter=Date.now()+Math.min(2000,this.effectiveRefreshMs);
    if(verdict.reason?.startsWith('bin_array_missing')||
      verdict.reason==='bin_array_wrong_pool')
     entry.needsReindex=true;
   }
   if(verdict.ok&&(entry.lastReady===false||
     entry.lastReady===true&&!wasReady))this.recoveryCount++;
   entry.lastReady=verdict.ok;
   if(verdict.ok){
    entry.notReadySince=undefined;entry.readySince??=Date.now();
   }else{
    entry.notReadySince??=Date.now();entry.readySince=undefined;
   }
  }catch(error){
   if(!this.running||this.entries.get(address)!==entry)return;
   entry.refreshFailures=(entry.refreshFailures??0)+1;
   entry.readTimedOut=record.timedOut;
   if(record.timedOut){
    this.rpcTimedOut++;entry.lastTimeoutAt=Date.now();
    entry.rpcTimeoutCause=entry.rpcPhase==='queued'?
     'queue_or_pacing':'transport_or_response';
    if(entry.rpcTimeoutCause==='queue_or_pacing')this.queueDeadlineExceeded++;
    else this.transportDeadlineExceeded++;
   }
   entry.retryAfter=Date.now()+Math.min(15000,
    1200*Math.pow(2,Math.min(4,entry.refreshFailures-1)));
   this.refreshFailures++;
   entry.quoteFailure='rpc_reconcile:'+message(error);
   this.report(address+': refresh '+message(error));
  }finally{
   if(deadlineTimer)clearTimeout(deadlineTimer);
   const elapsed=Date.now()-started;
   entry.refreshDurationMs=elapsed;
   this.timings.push(elapsed);if(this.timings.length>128)this.timings.shift();
   entry.refreshing=false;this.refreshInFlight--;
   this.lastRefreshAt=new Date().toISOString();
   if(this.running)this.onChange();
  }
 }
 /** SDK array recovery never runs inside the ordinary account refresh lane.
  * A timeout marks the old task obsolete, but its pool lock is retained until
  * the underlying SDK/RPC promise settles; it cannot commit a late window.
  */
 private async reindexEntry(entry:Entry):Promise<void>{
  const address=entry.candidate.address;
  if(!this.running||this.entries.get(address)!==entry||this.reindexes.has(address))
   return;
  const started=Date.now();
  this.reindexAttempts++;entry.reindexing=true;
  let valid=true;
  const work=this.updateArrays(entry,()=>valid&&this.running&&
   this.entries.get(address)===entry&&
   Date.now()-started<=this.reindexDeadlineMs);
  const record={entry,startedAt:started,promise:work};
  this.reindexes.set(address,record);
  void work.then(()=>{
   if(this.reindexes.get(address)===record)this.reindexes.delete(address);
  },()=>{
   if(this.reindexes.get(address)===record)this.reindexes.delete(address);
  });
  try{
   await this.withDeadline(work,this.reindexDeadlineMs,'dlmm_reindex_deadline_exceeded');
   if(this.running&&this.entries.get(address)===entry){
    this.reindexSuccesses++;entry.reindexFailures=0;entry.reindexRetryAfter=0;
    entry.quoteFailure=undefined;
   }
  }catch(error){
   valid=false;
   if(this.running&&this.entries.get(address)===entry){
    this.reindexFailures++;
    if(String(error).includes('deadline'))this.reindexTimedOut++;
    entry.reindexFailures=(entry.reindexFailures??0)+1;
    entry.needsReindex=true;
    entry.reindexRetryAfter=Date.now()+Math.min(30000,
     1500*Math.pow(2,Math.min(4,entry.reindexFailures-1)));
    entry.quoteFailure='reindex:'+message(error);
   }
  }finally{
   valid=false;entry.reindexing=false;
   if(this.running)this.onChange();
  }
 }
 private launchReindexes(){
  const available=Math.max(0,Math.min(this.reindexConcurrency-
   [...this.entries.values()].filter(e=>e.reindexing).length,
   this.maxOutstandingReindex-this.reindexes.size));
  if(!available)return;
  const at=Date.now();
  const due=[...this.entries.values()].filter(entry=>
   !this.reindexes.has(entry.candidate.address)&&
   (entry.reindexRetryAfter??0)<=at&&
   entry.needsReindex)
   .sort((a,b)=>Number(!!b.needsReindex)-Number(!!a.needsReindex)||
    a.lastReindexAt-b.lastReindexAt).slice(0,available);
  for(const entry of due)void withRpcPriority('background',()=>this.reindexEntry(entry));
 }
 /** Each timer tick dispatches independently of previous ticks.
  * In-flight map locks and a separate bound on underlying transport work
  * replace the global 'refreshing' flag that stalled the whole scheduler.
  * Awaiting refresh() is useful in tests; timer callbacks never await it.
  */
 async refresh():Promise<void>{
  if(!this.running)return;
  this.refreshCycles++;this.schedulerTicks++;
  this.dispatchedLastTick=0;this.refreshedPoolsLastCycle=0;
  const at=Date.now();
  const entries=[...this.entries.values()];
  this.skippedInFlight+=entries.filter(e=>this.rpcReads.has(e.candidate.address)).length;
  this.skippedBackoff+=entries.filter(e=>(e.retryAfter??0)>at).length;
  const available=Math.max(0,Math.min(
   this.refreshBudget,this.refreshConcurrency-this.refreshInFlight,
   this.maxOutstandingRpc-this.rpcReads.size));
  const candidates=entries.filter(e=>!this.rpcReads.has(e.candidate.address));
  const plans=planDlmmRefresh(candidates.map(entry=>({
   address:entry.candidate.address,
   lastVerifiedAt:this.oldestVerifiedAt(entry),
   retryAfter:entry.retryAfter??0,
   ready:this.state(entry,at).ok,
   solPair:this.isSolPair(entry)
  })),at,this.refreshBudget);
  this.skippedCapacity+=Math.max(0,plans.length-available);
  const tasks=plans.slice(0,available).flatMap(address=>{
   const entry=this.entries.get(address);
   return entry?[this.refreshEntry(entry)]:[];
  });
  this.dispatchedLastTick=tasks.length;
  this.refreshedPoolsLastCycle=tasks.length;
  // Only now allow low-priority work to enqueue. It cannot block
  // the already-dispatched live quote refreshes.
  this.launchReindexes();
  this.launchBootstraps();
  await Promise.allSettled(tasks);
  if(!this.running)return;
  this.status=this.pending.size>0&&!this.entries.size?'warming':
   [...this.entries.values()].some(x=>(x.refreshFailures??0)>0)||
   this.errors.some(x=>x.startsWith('DLMM refresh planner:'))?
   'partial_error':'ready';
 }
 private state(entry:Entry,now=Date.now()):{
  ok:boolean;reason?:string;observedAt?:number;poolSlot?:number;tickSlot?:number;
  slotGap?:number;oldestAgeMs?:number
 }{
  const addresses=[entry.candidate.address,...this.arrays(entry),
   ...(entry.bitmap?[entry.bitmap]:[])];
  if(entry.binX.length===0||entry.binY.length===0)
   return {ok:false,reason:'bin_arrays_not_prepared'};
  const observations:Observed[]=[];
  for(const address of addresses){
   const info=this.observed(address);
   if(!info)return {ok:false,reason:address===entry.candidate.address?
    'pool_state_missing':'bin_array_missing:'+address};
   if(info.owner!==METEORA_DLMM)return {ok:false,reason:'account_owner_mismatch'};
   observations.push(info);
  }
  const checks=observations.map(x=>({slot:x.verifiedSlot,receivedAt:x.verifiedAt}));
  const verdict=validateLocalComponents(checks,now,this.opts.maxAgeMs,this.opts.maxSlotSkew);
  const slots=observations.map(x=>x.verifiedSlot);
  const slotGap=Math.max(...slots)-Math.min(...slots);
  if(!verdict.ok)return {ok:false,reason:verdict.reason,slotGap,
   oldestAgeMs:now-verdict.oldestAt};
  try{
   const sdk=entry.sdk;
   const acc=sdk.program.coder.accounts.decode('lbPair',observations[0].data) as typeof sdk.lbPair;
   if(acc.tokenXMint.toBase58()!==sdk.tokenX.publicKey.toBase58()||
      acc.tokenYMint.toBase58()!==sdk.tokenY.publicKey.toBase58())
    return {ok:false,reason:'pool_mints_changed'};
   if(entry.bitmap){
    const obs=this.observed(entry.bitmap);
    if(!obs)return {ok:false,reason:'bitmap_extension_missing'};
    sdk.program.coder.accounts.decode('binArrayBitmapExtension',obs.data);
   }
   for(const address of this.arrays(entry)){
    const obs=this.observed(address);
    if(!obs)return {ok:false,reason:'bin_array_missing:'+address};
    const bin=sdk.program.coder.accounts.decode('binArray',obs.data) as BinArrayAccount['account'];
    if(bin.lbPair.toBase58()!==entry.candidate.address)
     return {ok:false,reason:'bin_array_wrong_pool'};
   }
   return {ok:true,observedAt:verdict.oldestAt,
    poolSlot:observations[0].verifiedSlot,
    tickSlot:Math.min(...observations.slice(1).map(x=>x.verifiedSlot)),
    slotGap,oldestAgeMs:now-verdict.oldestAt};
  }catch(error){return {ok:false,reason:'dlmm_decode_error:'+message(error)}}
 }
 quote(address:string,inputMint:string,inputRaw:bigint,now=Date.now()):bigint|null{
  if(!this.running||inputRaw<=0n)return null;
  const entry=this.entries.get(address);if(!entry||!this.state(entry,now).ok)return null;
  try{
   const sdk=entry.sdk,fromX=sdk.lbPair.tokenXMint.toBase58()===inputMint;
   if(!fromX&&sdk.lbPair.tokenYMint.toBase58()!==inputMint)return null;
   // Decode verified account bytes into the official protocol model.
   const pool=this.observed(address);
   if(!pool)return null;
   sdk.lbPair=sdk.program.coder.accounts.decode('lbPair',pool.data) as typeof sdk.lbPair;
   if(entry.bitmap){
    const bitmap=this.observed(entry.bitmap);
    if(!bitmap||!sdk.binArrayBitmapExtension)return null;
    sdk.binArrayBitmapExtension.account=sdk.program.coder.accounts.decode(
     'binArrayBitmapExtension',bitmap.data) as typeof sdk.binArrayBitmapExtension.account;
   }
   const names=fromX?entry.binX:entry.binY;
   const bins=names.map(key=>{
    const data=this.observed(key);
    if(!data)throw Error('bin_array_missing');
    const account=sdk.program.coder.accounts.decode('binArray',data.data) as BinArrayAccount['account'];
    return {publicKey:new PublicKey(key),account};
   });
   // Both output and dynamic fees are calculated using Meteora's SDK.
   // Never allow an SDK partial fill to masquerade as a full exact input.
   const quote=sdk.swapQuote(new BN(inputRaw.toString()),fromX,new BN(0),bins,false);
   if(!quote.outAmount||quote.outAmount.lten(0)){
    entry.quoteFailure='zero_output';return null;
   }
   if(quote.consumedInAmount.toString()!==inputRaw.toString()){
    entry.quoteFailure='partial_fill';entry.needsReindex=true;return null;
   }
   entry.lastQuoteAt=new Date(now).toISOString();entry.quoteFailure=undefined;
   this.localQuotes++;
   return BigInt(quote.outAmount.toString());
  }catch(error){
   this.quoteFailures++;
   entry.quoteFailure=message(error);entry.needsReindex=true;
   return null;
  }
 }
 graphPools(now=Date.now()):GraphPool[]{
  if(!this.running)return [];
  const result:GraphPool[]=[];
  for(const entry of this.entries.values()){
   const v=this.state(entry,now);
   if(!v.ok||!v.observedAt||v.poolSlot===undefined||v.tickSlot===undefined)continue;
   const a=assetOfMint(entry.sdk.lbPair.tokenXMint.toBase58());
   const b=assetOfMint(entry.sdk.lbPair.tokenYMint.toBase58());
   if(!a||!b)continue;
   const address=entry.candidate.address;
   result.push({
    address,program:'meteora_dlmm',tokenA:a,tokenB:b,
    reserveA:'0',reserveB:'0',feeNumerator:'0',feeDenominator:'1000000',
    observedAt:new Date(v.observedAt).toISOString(),poolSlot:v.poolSlot,
    vaultSlot:v.tickSlot,liquidityUsd:entry.candidate.liquidityUsd,
    snapshotIntegrity:'bounded_slot_research',
    quoteExactInput:(from,raw)=>{
     const mint=GRAPH_ASSETS[from]?.mint;
     return mint?this.quote(address,mint,raw):null;
    }
   });
  }
  return result;
 }
 snapshot(now=Date.now()):DlmmHealth{
  const perPool=this.candidates.map(c=>{
   const entry=this.entries.get(c.address);
   const value=entry?this.state(entry,now):{ok:false,reason:this.pending.has(c.address)?
    'bootstrapping_bin_arrays':'pool_not_prepared'};
   if(entry){
    if(value.ok){
     entry.readySince??=now;
     entry.notReadySince=undefined;
    }else{
     entry.notReadySince??=now;
     entry.readySince=undefined;
    }
   }
   return {address:c.address,pair:assetOfMint(c.mintA)+'/'+assetOfMint(c.mintB),
    status:(value.ok?'ready':this.pending.has(c.address)?'warming':'not_ready') as DlmmPoolReadiness['status'],
    reason:value.ok?undefined:value.reason,quoteFailure:entry?.quoteFailure,
    binArrays:entry?this.arrays(entry).length:0,
    oldestAgeMs:'oldestAgeMs' in value?value.oldestAgeMs??null:null,
    slotGap:'slotGap' in value?value.slotGap??null:null,
    lastQuoteAt:entry?.lastQuoteAt,lastVerifiedAt:entry?.lastVerifiedAt?
     new Date(entry.lastVerifiedAt).toISOString():undefined,
    refreshFailures:entry?.refreshFailures??0,
    refreshing:entry?.refreshing??false,
    notReadyForMs:value.ok?null:Math.max(0,now-(entry?.notReadySince??now)),
    refreshDurationMs:entry?.refreshDurationMs??null,
    reindexing:entry?.reindexing??false,
    readTimedOut:entry?.readTimedOut??false,
    lastTimeoutAt:entry?.lastTimeoutAt?
     new Date(entry.lastTimeoutAt).toISOString():undefined,
    rpcQueueWaitMs:entry?.rpcQueueWaitMs,
    rpcTransportMs:entry?.rpcTransportMs,
    rpcTimeoutCause:entry?.rpcTimeoutCause,
    windowBinIndex:entry?.windowBinIndex,
    readySince:entry?.readySince?new Date(entry.readySince).toISOString():undefined,
    continuousReadyMs:value.ok&&entry?.readySince!==undefined?
     Math.max(0,now-entry.readySince):null};
  });
  const reasonCounts:Record<string,number>={};
  for(const p of perPool)if(p.status!=='ready'){
   const reason=(p.reason??'unknown').split(':')[0];
   reasonCounts[reason]=(reasonCounts[reason]??0)+1;
  }
  const ages=perPool.map(p=>p.oldestAgeMs).filter((n):n is number=>n!==null);
  const durations=[...this.timings].sort((a,b)=>a-b);
  const durationP95=durations.length?
   durations[Math.max(0,Math.ceil(durations.length*0.95)-1)]:0;
  const durationAvg=durations.length?
   Math.round(durations.reduce((sum,x)=>sum+x,0)/durations.length):0;
  const outstanding=[...this.rpcReads.values()];
  return {status:this.status,tracked:this.candidates.length,
   ready:perPool.filter(x=>x.status==='ready').length,
   bootstrapAttempts:this.bootstrapAttempts,bootstrapFailures:this.bootstrapFailures,
   localQuotes:this.localQuotes,quoteFailures:this.quoteFailures,
   verifiedAccountRefreshes:this.verifiedAccountRefreshes,pending:this.pending.size,
   lastRefreshAt:this.lastRefreshAt,perPool,errors:[...this.errors],
   refreshCycles:this.refreshCycles,refreshAttempts:this.refreshAttempts,
   refreshSuccesses:this.refreshSuccesses,refreshFailures:this.refreshFailures,
   refreshInFlight:this.refreshInFlight,peakRefreshInFlight:this.peakRefreshInFlight,
   refreshedPoolsLastCycle:this.refreshedPoolsLastCycle,
   refreshBudget:this.refreshBudget,refreshConcurrency:this.refreshConcurrency,
   effectiveRefreshMs:this.effectiveRefreshMs,
   oldestAccountAgeMs:ages.length?Math.max(...ages):null,
   reasonCounts,recoveryCount:this.recoveryCount,
   backoffPools:[...this.entries.values()].filter(e=>(e.retryAfter??0)>now).length,
   schedulerTicks:this.schedulerTicks,dispatchedLastTick:this.dispatchedLastTick,
   skippedInFlight:this.skippedInFlight,skippedCapacity:this.skippedCapacity,
   skippedBackoff:this.skippedBackoff,outstandingRpcReads:this.rpcReads.size,
   oldestOutstandingRpcMs:outstanding.length?
    Math.max(...outstanding.map(x=>Math.max(0,now-x.startedAt))):0,
   rpcDeadlineMs:this.rpcDeadlineMs,rpcTimedOut:this.rpcTimedOut,
   rpcLateSettled:this.rpcLateSettled,partialRefreshes:this.partialRefreshes,
   refreshDurationMsP95:durationP95,refreshDurationMsAvg:durationAvg,
   reindexInFlight:this.reindexes.size,reindexAttempts:this.reindexAttempts,
   reindexSuccesses:this.reindexSuccesses,reindexFailures:this.reindexFailures,
   reindexTimedOut:this.reindexTimedOut,bootstrapInFlight:this.pending.size,
   bootstrapConcurrency:this.bootstrapConcurrency,
   bootstrapDeferred:this.bootstrapDeferred,
   bootstrapPhysicalInFlight:this.bootstrapPhysical.size,
   windowShiftReindexes:this.windowShiftReindexes,
   periodicReindexesRemoved:true,
   queueDeadlineExceeded:this.queueDeadlineExceeded,
   transportDeadlineExceeded:this.transportDeadlineExceeded};
 }
 stop(){
  this.running=false;if(this.timer)clearInterval(this.timer);
  this.eventRelease?.();this.eventRelease=undefined;
  for(const key of [...this.entries.keys()])this.forget(key);
  this.candidates=[];this.bootstrapRetry.clear();this.status='stopped';
 }
}
