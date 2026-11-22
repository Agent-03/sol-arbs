import {PublicKey,type Connection} from '@solana/web3.js';
import {discoverPools,type DiscoveredPool} from './discovery.js';
import {LiveRaydiumMonitor,type LiveRaydiumEvent} from './liveRaydium.js';
import {OrcaMonitor,type ArbitrageCandidate} from './orca.js';
import {ClmmMonitor} from './clmm.js';
import {classifyPoolEligibility,computeCoverage} from './poolEligibility.js';
import {combineLiveQuotes,type LiveCombination} from './liveRoutes.js';
import {buildCandidates,RAYDIUM_AMM_V4,ORCA_WHIRLPOOL,RAYDIUM_CLMM} from './routes.js';
import {assessRoutes,type RouteSummary} from './opportunities.js';
import {Scanner,type PoolChange} from './scanner.js';
import type {Config} from './config.js';
import type {RpcProviderPool} from './rpcFailover.js';
import type {JupiterMonitor} from './jupiter.js';
import type {MarketDataFeed} from './marketData.js';

type Activity={id:number;at:string;level:'info'|'success'|'warning';kind:string;message:string};
type History={at:string;comparable:number;positive:number;excluded:number;bestNetUsd:number|null;total:number};
type Busy='idle'|'quoting'|'discovering'|'bootstrapping';
type EventSource='raydium_ws'|'raydium_reconcile'|'orca_refresh'|'clmm_refresh';
const emptyCombination=():LiveCombination=>({candidates:[],unmatchedReverseLegs:0,failed:0,evaluated:0,clmmEvaluated:0});

export class MarketEngine {
 private readonly pools:DiscoveredPool[];
 private topology:ReturnType<typeof buildCandidates>;
 private readonly ray:LiveRaydiumMonitor;
 private readonly orca:OrcaMonitor;
 private readonly clmm:ClmmMonitor;
 private readonly activeSizesUsd:number[];
 private running=false;
 private busy:Busy='idle';
 private timer?:ReturnType<typeof setTimeout>;
 private lastScanAt?:string;
 private lastScanStartedAt?:string;
 private nextScanAt?:string;
 private lastScanDurationMs?:number;
 private cycles=0;
 private lastDiscoveryAt:string;
 private lastDiscoveryAttempt=0;
 private lastDiscoveryReason='startup';
 private discoveryStatus:'ok'|'partial_error'='ok';
 private discoveryWarnings:string[];
 private discoveryValidated:number;
 private discoveryAdded=0;
 private discoveryRemoved=0;
 private discoveryRuns=1;
 private lastManualScanAt=0;
 private lastC2ValidationAt=0;
 private lastManualDiscoveryAt=0;
 private events:Activity[]=[];
 private histories:History[]=[];
 private eventId=0;
 private lastNetPositive=false;
 private previousRateLimits=0;
 private previousFailovers=0;
 private unsubscribeScanner?:()=>void;
 private liveCandidates:ArbitrageCandidate[]=[];
 private combination:LiveCombination=emptyCombination();
 private marketEvents=0;
 private localEvaluations=0;
 private marketEventEvaluations=0;
 private orcaTriggers=0;
 private suppressedTriggers=0;
 private readonly pendingOrcaPools=new Set<string>();
 private lastFullOrcaRefreshAt=0;
 private selectiveOrcaRefreshes=0;
 private lastSyncReconcileAt=0;
 private syncReconcilesRequested=0;
 private latencySamples:number[]=[];
 private lastEvaluationAt?:string;
 private lastEventAt?:string;
 private lastSource?:EventSource;
 private lastOrcaStartedAt=0;
 private lastOrcaFinishedAt?:string;
 private lastHistoryAt=0;

 constructor(
  private readonly conn:Connection,
  private readonly config:Config,
  private readonly scanner:Scanner,
  private readonly rpc:RpcProviderPool,
  private readonly jupiter:JupiterMonitor,
  discovered:Awaited<ReturnType<typeof discoverPools>>,
  private readonly manualPools:PublicKey[],
  private readonly marketData?:MarketDataFeed
 ){
  this.pools=[...discovered.pools];
  for(const pool of this.pools){
   this.marketData?.expectOwner(pool.address,pool.owner);
   this.marketData?.setDependencies(pool.address,[pool.address]);
  }
  this.activeSizesUsd=config.b52OrcaQuoteMode==='fast'?
   [Math.min(...config.b5QuoteSizesUsd)]:[...config.b5QuoteSizesUsd];
  this.topology=buildCandidates(this.pools);
  this.discoveryWarnings=discovered.warnings;
  this.discoveryValidated=discovered.validatedCount??discovered.pools.length;
  this.lastDiscoveryAt=new Date().toISOString();
  this.lastDiscoveryAttempt=Date.now();
  this.ray=new LiveRaydiumMonitor(
   conn,this.pools,this.activeSizesUsd,config.ammMaxSlotSkew,
   config.b5MaxComponentAgeMs,config.minQuoteLiquidityUsd,
   config.b5ReconcileMs,event=>this.onRaydiumEvent(event),this.marketData
  );
  this.clmm=new ClmmMonitor(conn,this.pools,this.activeSizesUsd,
   config.minQuoteLiquidityUsd,config.b51ClmmMaxPools,
   config.b51ClmmRefreshMs,config.b51ClmmMaxCacheAgeMs,
   ()=>this.evaluate('clmm_refresh',Date.now(),false),
   config.c2LocalQuotesEnabled?this.marketData:undefined,
   config.freshness.maxSlotSkew);
  this.orca=new OrcaMonitor(conn,this.pools,this.activeSizesUsd,
   ()=>this.ray.snapshot().quotes,config.jupiter.assumedCostUsd,
   config.b5OrcaRefreshMs,config.minQuoteLiquidityUsd,
   ()=>this.evaluate('orca_refresh',Date.now(),false),
   config.freshness.maxAgeMs,
   ()=>this.clmm.getBuys().map(q=>({pool:q.pool,inputRaw:q.inputRaw,
    outputRaw:q.outputRaw,observedAt:q.observedAt,slot:q.poolSlot})),
   config.b52OrcaQuoteMode,
   ()=>this.requestRaydiumAlignment(),
   config.c2LocalQuotesEnabled?this.marketData:undefined,
   this.config.freshness.maxSlotSkew);
  this.note('info','startup','B5 read-only engine initialized. Raydium vaults: WebSocket state; Orca: SDK refreshes.');
 }
 private note(level:Activity['level'],kind:string,message:string){
  this.events.unshift({id:++this.eventId,at:new Date().toISOString(),level,kind,message});
  this.events=this.events.slice(0,24);
 }
 private requestRaydiumAlignment(){
  // A new Orca buy quote has arrived. Re-read Raydium in one pool/vault
  // RPC context only occasionally, avoiding a stale unchanged reserve
  // timestamp while still honoring the global request limiter.
  const now=Date.now();
  if(!this.running||now-this.lastSyncReconcileAt<12000)return;
  this.lastSyncReconcileAt=now;
  this.syncReconcilesRequested++;
  void this.ray.reconcileAll();
 }
 private readonly minManualScanMs=30000;
 private readonly minManualDiscoveryMs=120000;
 private schedule(delayMs=this.config.b5OrcaRefreshMs){
  if(!this.running)return;
  if(this.timer)clearTimeout(this.timer);
  const ms=Math.max(100,delayMs);
  this.nextScanAt=new Date(Date.now()+ms).toISOString();
  this.timer=setTimeout(()=>{void this.scan('scheduled');},ms);
 }
 private discoveryInterval():number{
  return this.lastNetPositive?this.config.discoveryRefreshMs:this.config.noProfitDiscoveryMs;
 }
 private percentiles(){
  const values=[...this.latencySamples].sort((a,b)=>a-b);
  if(!values.length)return {p50Ms:null,p95Ms:null,maxMs:null};
  return {p50Ms:values[Math.floor((values.length-1)*0.5)],
   p95Ms:values[Math.floor((values.length-1)*0.95)],maxMs:values[values.length-1]};
 }
 private evaluatedSummary(){
  return assessRoutes(this.liveCandidates,{
   ...this.config.freshness,minLiquidityUsd:this.config.minQuoteLiquidityUsd
  });
 }
 private evaluate(source:EventSource,receivedAt:number,recordEvent:boolean){
  if(!this.running)return;
  const active=new Set(this.pools.map(p=>p.address));
  const rayQuotes=this.ray.snapshot().quotes.filter(q=>active.has(q.pool));
  const orcaLegs=this.orca.snapshot().quotedLegs.filter(q=>active.has(q.pool));
  const liquidity=new Map(this.pools.map(p=>[p.address,p.liquidityUsd] as const));
  const clmmBuys=this.clmm.getBuys();
  this.combination=combineLiveQuotes(rayQuotes,orcaLegs,
   this.config.jupiter.assumedCostUsd,liquidity,clmmBuys,
   (pool,amount)=>this.clmm.quoteExact(pool,'SOL_TO_USDC',amount));
  this.liveCandidates=this.combination.candidates;
  this.localEvaluations++;
  if(recordEvent)this.marketEventEvaluations++;
  this.lastSource=source;
  this.lastEvaluationAt=new Date().toISOString();
  const latencyMs=Math.max(0,Date.now()-receivedAt);
  this.latencySamples.push(latencyMs);
  if(this.latencySamples.length>256)this.latencySamples.shift();
  const evaluated=this.evaluatedSummary();
  this.lastNetPositive=evaluated.positiveComparable>0;
  if(Date.now()-this.lastHistoryAt>=1500){
   const at=this.lastEvaluationAt;
   this.histories.push({at,comparable:evaluated.comparable,positive:evaluated.positiveComparable,
    excluded:evaluated.excluded,bestNetUsd:evaluated.bestComparableNetUsd,total:evaluated.total});
   this.histories=this.histories.slice(-48);
   this.lastHistoryAt=Date.now();
  }
  if(evaluated.positiveComparable>0&&source!=='raydium_reconcile'){
   this.note('success','estimate',evaluated.positiveComparable+' positive indicative comparisons; NOT execution-verified');
  }
 }
 private onRaydiumEvent(event:LiveRaydiumEvent){
  if(!this.running||this.busy==='discovering')return;
  if(event.source==='websocket'){
   this.marketEvents++;
   this.lastEventAt=new Date(event.receivedAt).toISOString();
  }
  this.evaluate(event.source==='websocket'?'raydium_ws':'raydium_reconcile',
   event.receivedAt,event.source==='websocket');
 }
 private onPoolEvent(event:PoolChange){
  if(!this.running||event.source!=='websocket')return;
  const p=this.pools.find(p=>p.address===event.address);
  if(p?.owner===RAYDIUM_CLMM){
   this.clmm.requestPoolRefresh(p.address);
   return;
  }
  if(p?.owner!==ORCA_WHIRLPOOL)return;
  if(this.orca.hasLocalPricing(p.address)){
   // The shared feed has already notified the local Whirlpool calculator;
   // scheduling another SDK round-trip would turn a fast event into a
   // ~30-second request queue. Periodic fallback scans still reconcile.
   this.orcaTriggers++;
   return;
  }
  this.orcaTriggers++;
  this.pendingOrcaPools.add(p.address);
  const latestCycle=this.lastOrcaFinishedAt?Date.parse(this.lastOrcaFinishedAt):this.lastOrcaStartedAt;
  if(this.busy!=='idle'||Date.now()-latestCycle<this.config.b5OrcaMinTriggerMs){
   this.suppressedTriggers++;return;
  }
  // Once a refresh has been queued, do NOT repeatedly reset its debounce
  // timer under a stream of pool changes. Preserve the shared RPC limiter.
  if(this.nextScanAt && Date.parse(this.nextScanAt)<=Date.now()+1000){
   this.suppressedTriggers++;return;
  }
  this.schedule(300);
 }
 async start(){
  if(this.running)return;
  this.running=true;
  this.busy='bootstrapping';
  this.unsubscribeScanner=this.scanner.onUpdate(e=>this.onPoolEvent(e));
  try{
   await this.scanner.start();
   await this.ray.start();
   this.clmm.start();
   this.note('success','feed','Raydium pool and vault subscriptions active; local pricing enabled.');
   this.busy='idle';
   this.schedule(100);
  }catch(error){
   this.busy='idle';
   this.note('warning','startup','Feed bootstrap failed: '+String(error));
   if(this.running)this.schedule(1000);
  }
 }
 async stop(){
  this.running=false;
  if(this.timer)clearTimeout(this.timer);
  this.unsubscribeScanner?.();this.unsubscribeScanner=undefined;
  this.orca.stop();
  this.clmm.stop();
  await this.ray.stop();
  await this.scanner.stop();
 }
 requestScan():{accepted:boolean;message:string}{
  if(!this.running)return {accepted:false,message:'Engine not started'};
  if(this.busy!=='idle')return {accepted:false,message:'A quote refresh or discovery is running'};
  const left=this.minManualScanMs-(Date.now()-this.lastManualScanAt);
  if(left>0)return {accepted:false,message:'Scan cooldown: '+Math.ceil(left/1000)+'s'};
  this.lastManualScanAt=Date.now();
  this.schedule(100);
  return {accepted:true,message:'Orca SDK refresh requested; Raydium continues responding to live events'};
 }
 requestC2Validation():{accepted:boolean;message:string}{
  if(!this.running||this.busy!=='idle')
   return {accepted:false,message:'Engine is not idle'};
  const remaining=60000-(Date.now()-this.lastC2ValidationAt);
  if(remaining>0)return {accepted:false,message:'Reference validation cooldown: '+Math.ceil(remaining/1000)+'s'};
  this.lastC2ValidationAt=Date.now();
  void this.orca.validateReferenceOnce().then(result=>{
   this.note(result.accepted?'info':'warning','c2_reference',result.message);
  }).catch(error=>this.note('warning','c2_reference','SDK cross-check failed: '+String(error)));
  return {accepted:true,message:'Read-only one-pool SDK comparison requested; see /api/c2 for outcome'};
 }
 requestDiscovery():{accepted:boolean;message:string}{
  if(!this.running)return {accepted:false,message:'Engine not started'};
  if(this.busy!=='idle')return {accepted:false,message:'A quote refresh or discovery is running'};
  const left=this.minManualDiscoveryMs-(Date.now()-this.lastManualDiscoveryAt);
  if(left>0)return {accepted:false,message:'Discovery cooldown: '+Math.ceil(left/1000)+'s'};
  this.lastManualDiscoveryAt=Date.now();
  if(this.timer)clearTimeout(this.timer);
  void this.discoverAndResume('manual');
  return {accepted:true,message:'Validating a wider SOL/USDC pool universe'};
 }
 private async discoverAndResume(reason:string){
  if(this.busy!=='idle')return;
  this.busy='discovering';
  try{await this.refreshUniverse(reason);}
  catch(error){
   this.discoveryStatus='partial_error';
   this.discoveryWarnings=[String(error)];
   this.note('warning','discovery','Discovery refresh failed; previous universe retained');
  }finally{
   this.busy='idle';
   this.schedule(1000);
  }
 }
 private async refreshUniverse(reason:string){
  this.busy='discovering';
  this.lastDiscoveryAttempt=Date.now();
  this.lastDiscoveryReason=reason;
  this.note('info','discovery',reason==='manual'?'Manual discovery started':
   reason==='no_fresh_profitable_routes'?'No positive comparable spreads; rotating supported pools':'Scheduled pool discovery started');
  const result=await discoverPools(this.conn,this.manualPools,this.config.maxPools,this.discoveryRuns);
  this.discoveryRuns++;
  this.discoveryWarnings=result.warnings;
  this.discoveryValidated=result.validatedCount??result.pools.length;
  if(!result.pools.length){
   this.discoveryStatus='partial_error';
   this.note('warning','discovery','No validated pools returned; retaining existing subscriptions');
   return;
  }
  const oldHasBoth=this.pools.some(p=>p.owner===RAYDIUM_AMM_V4)&&this.pools.some(p=>p.owner===ORCA_WHIRLPOOL);
  const newHasBoth=result.pools.some(p=>p.owner===RAYDIUM_AMM_V4)&&result.pools.some(p=>p.owner===ORCA_WHIRLPOOL);
  if(oldHasBoth&&!newHasBoth){
   this.discoveryStatus='partial_error';
   this.note('warning','discovery','Refresh lost a supported venue; retaining previous universe');
   return;
  }
  const old=new Set(this.pools.map(p=>p.address));
  const next=new Set(result.pools.map(p=>p.address));
  this.discoveryAdded=[...next].filter(p=>!old.has(p)).length;
  this.discoveryRemoved=[...old].filter(p=>!next.has(p)).length;
  for(const pool of result.pools){
   this.marketData?.expectOwner(pool.address,pool.owner);
   if(!this.marketData?.hasDependencies(pool.address))
    this.marketData?.setDependencies(pool.address,[pool.address]);
  }
  await this.scanner.replacePools(result.pools.map(p=>new PublicKey(p.address)));
  this.pools.splice(0,this.pools.length,...result.pools);
  await this.ray.replacePools();
  // A pool retained in discovery but removed from the *quoted* Raydium
  // subset still needs its public pool account tracked for diagnostics.
  for(const pool of this.pools)if(!this.marketData?.hasDependencies(pool.address))
   this.marketData?.setDependencies(pool.address,[pool.address]);
  for(const address of old)if(!next.has(address))this.marketData?.clearDependencies(address);
  void this.clmm.scanOnce();
  this.topology=buildCandidates(this.pools);
  this.lastDiscoveryAt=new Date().toISOString();
  this.discoveryStatus=result.warnings.length?'partial_error':'ok';
  this.evaluate('raydium_reconcile',Date.now(),false);
  this.note(this.discoveryStatus==='ok'?'success':'warning','discovery',
   'Refreshed: '+this.pools.length+' pools; '+this.discoveryAdded+' added; '+this.discoveryRemoved+' removed');
 }
 private async scan(reason:string){
  if(!this.running||this.busy!=='idle')return;
  this.busy='quoting';
  const began=Date.now();
  const fullRefresh=reason==='manual' ||
    began-this.lastFullOrcaRefreshAt>=this.config.b5OrcaRefreshMs ||
    this.pendingOrcaPools.size===0;
  const onlyPools=fullRefresh?undefined:new Set(this.pendingOrcaPools);
  this.pendingOrcaPools.clear();
  this.lastOrcaStartedAt=began;
  this.lastScanStartedAt=new Date(began).toISOString();
  this.nextScanAt=undefined;
  if(reason==='scheduled')this.note('info','orca','Refreshing Orca SDK quotes; Raydium remains event-driven');
  try{
   await this.orca.scanOnce(onlyPools);
   if(fullRefresh)this.lastFullOrcaRefreshAt=Date.now();
   else this.selectiveOrcaRefreshes++;
   if(!this.running)return;
   this.evaluate('orca_refresh',Date.now(),false);
   const result=this.evaluatedSummary();
   this.cycles++;
   this.lastScanAt=new Date().toISOString();
   this.lastOrcaFinishedAt=this.lastScanAt;
   this.lastScanDurationMs=Date.now()-began;
   const rpc=this.rpc.snapshot();
   const rateLimits=(rpc.primary.rateLimits??0)+(rpc.secondary?.rateLimits??0);
   if(rateLimits>this.previousRateLimits)
    this.note('warning','rpc',(rateLimits-this.previousRateLimits)+' new HTTP 429 responses');
   if(rpc.failovers>this.previousFailovers)
    this.note('info','rpc',(rpc.failovers-this.previousFailovers)+' requests used the backup provider');
   this.previousRateLimits=rateLimits;
   this.previousFailovers=rpc.failovers;
   if(!result.total)this.note('warning','coverage','No contiguous cross-DEX quotes; check Orca errors and pool state');
   else if(!result.comparable)this.note('info','freshness',
    result.total+' route estimates evaluated; none pass timing/slot/liquidity criteria');
   else this.note('info','comparison',result.comparable+' comparable routes, '+result.positiveComparable+' positive after assumed costs');
   const due=Date.now()-Math.max(this.lastDiscoveryAttempt,Date.parse(this.lastDiscoveryAt))>=this.discoveryInterval();
   if(this.running&&due){
    try{await this.refreshUniverse(this.lastNetPositive?'scheduled':'no_fresh_profitable_routes');}
    catch(error){
     this.discoveryStatus='partial_error';this.discoveryWarnings=[String(error)];
     this.note('warning','discovery','Discovery failed; existing pool set retained');
    }
   }
  }catch(error){
   this.note('warning','orca','Orca quote cycle failed: '+String(error));
  }finally{
   this.busy='idle';
   if(this.running)this.schedule();
  }
 }
 assessment():RouteSummary{return this.evaluatedSummary();}
 dashboard(){
  const comparison=this.assessment();
  const r=this.ray.snapshot(),o=this.orca.snapshot(),s=this.scanner.snapshot(),cl=this.clmm.snapshot();
  const cover={
   raydiumV4:this.pools.filter(p=>p.owner===RAYDIUM_AMM_V4).length,
   orcaWhirlpool:this.pools.filter(p=>p.owner===ORCA_WHIRLPOOL).length,
   raydiumClmm:this.pools.filter(p=>p.owner===RAYDIUM_CLMM).length
  };
  const rpc=this.rpc.snapshot();
  const market=this.marketData?.snapshot();
  const poolEligibility=classifyPoolEligibility(this.pools,r,o,cl,
   this.config.minQuoteLiquidityUsd,this.config.b51ClmmMaxPools,this.config.freshness.maxAgeMs);
  const coverage=computeCoverage(poolEligibility,this.activeSizesUsd.length,
   comparison.total,comparison.comparable,comparison.positiveComparable,comparison.negativeComparable,
   this.config.b52OrcaQuoteMode==='fast'?1:2);
  const statuses=[
   {label:'Unprofitable',count:comparison.negativeComparable,reason:'Valid research comparisons with net ≤ 0'},
   {label:'Positive estimate',count:comparison.positiveComparable,reason:'Positive estimate; not simulated or executable'},
   {label:'Stale / unaligned',count:comparison.excluded,reason:'Time, slot or liquidity checks failed'},
   {label:'Missing reverse route',count:this.config.b52OrcaQuoteMode==='fast'?0:this.combination.unmatchedReverseLegs,
    reason:this.config.b52OrcaQuoteMode==='fast'?'Reverse direction deliberately paused in fast diagnostic mode':'No exact-input Orca reverse quote for Raydium leg'}
  ];
  const reasons=Object.entries(comparison.excludedByReason).sort((a,b)=>b[1]-a[1]);
  return {
   phase:'C2',mode:'READ_ONLY',
   c1:market?{...market,streamingFeed:'Solana WebSocket account notifications; Yellowstone/Geyser transport not connected',
    localCalculation:'Raydium AMM v4 pool/vault states; CLMM and Orca SDK still request RPC-backed tick arrays'}:null,now:new Date().toISOString(),market:'SOL/USDC',
   status:this.busy==='idle'?'monitoring':this.busy,
   scan:{status:this.busy,lastStartedAt:this.lastScanStartedAt,lastFinishedAt:this.lastScanAt,
    lastDurationMs:this.lastScanDurationMs,completedCycles:this.cycles,
    intervalMs:this.config.b5OrcaRefreshMs,nextAt:this.nextScanAt},
   b5:{quoteMode:this.config.b52OrcaQuoteMode,activeSizesUsd:[...this.activeSizesUsd],
    monitoredDirections:this.config.b52OrcaQuoteMode==='fast'?['orca_to_raydium_amm_v4','orca_to_raydium_clmm']:['orca_to_raydium_amm_v4','orca_to_raydium_clmm','raydium_amm_v4_to_orca','raydium_clmm_to_orca'],
    architecture:'Raydium WebSocket pool/vault cache + local route math; Orca SDK refreshed on a bounded schedule',
    raydiumTransport:'WebSocket + periodic coherent-context HTTP reconciliation',
    orcaTransport:'SDK/RPC refreshed on pool changes with cooldown, plus periodic refresh',
    marketEvents:this.marketEvents,localRecomputations:r.localRecomputations,
    localEvaluations:this.localEvaluations,eventEvaluations:this.marketEventEvaluations,
    orcaEventTriggers:this.orcaTriggers,coalescedTriggers:this.suppressedTriggers,
    selectiveOrcaRefreshes:this.selectiveOrcaRefreshes,pendingOrcaPools:this.pendingOrcaPools.size,
    requestedRaydiumSyncReads:this.syncReconcilesRequested,
    lastMarketEventAt:this.lastEventAt,lastEvaluationAt:this.lastEvaluationAt,
    lastEvaluationSource:this.lastSource,wsSubscriptions:r.subscriptions,
    raydiumReadyPools:r.readyPools,raydiumTrackedPools:r.poolCount,
    raydiumReconcilations:r.reconciliations,
    lastOrcaRefreshAt:this.lastOrcaFinishedAt,
    latency:this.percentiles(),latencyDefinition:'Milliseconds from local update callback receipt to local route recomputation (not chain-to-bot latency)',
    routeEvaluations:this.combination.evaluated,
    clmmEvaluations:this.combination.clmmEvaluated,
    exactInputMisses:this.config.b52OrcaQuoteMode==='fast'?0:this.combination.unmatchedReverseLegs,
    unmonitoredReverseDirections:this.config.b52OrcaQuoteMode==='fast',
    scanTiming:{durationMs:o.lastScanDurationMs,firstBuyMs:o.lastFirstBuyDelayMs,
      poolPreparationMs:o.lastPoolSetupMs,buyQuotes:o.lastBuyCount,reverseQuotes:o.lastReverseCount},
    evaluationFailures:this.combination.failed,
    statuses,topExclusionReason:reasons[0]?.[0]??null,
    limitations:['Orca SDK tick arrays use RPC, not a fully memory-resident quote engine',
     'CLMM SDK pool/tick bitmap snapshots involve multiple independent RPC contexts',
     'Raydium vault-only CPMM ignores OpenBook open orders',
     'Slot proximity does not imply atomic same-state execution',
     'No transaction simulation, signing or broadcast']},
   discovery:{status:this.discoveryStatus,lastAt:this.lastDiscoveryAt,
    nextAt:new Date(Math.max(this.lastDiscoveryAttempt,Date.parse(this.lastDiscoveryAt))+this.discoveryInterval()).toISOString(),
    intervalMs:this.discoveryInterval(),reason:this.lastDiscoveryReason,
    validatedCandidates:this.discoveryValidated,trackedPools:this.pools.length,
    newlyAdded:this.discoveryAdded,removed:this.discoveryRemoved,
    quoteSupportedPools:coverage.supportedEligiblePools,
    lowLiquidityExcluded:this.pools.filter(p=>[RAYDIUM_AMM_V4,RAYDIUM_CLMM,ORCA_WHIRLPOOL].includes(p.owner)&&
     p.liquidityUsd!==undefined&&p.liquidityUsd<this.config.minQuoteLiquidityUsd).length,
    coverage:cover,eligibility:poolEligibility,utility:coverage,
    theoreticalTopologies:this.topology.candidates.length,warnings:this.discoveryWarnings},
   opportunities:{total:comparison.total,comparable:comparison.comparable,
    excluded:comparison.excluded,positive:comparison.positiveComparable,
    negative:comparison.negativeComparable,bestComparableNetUsd:comparison.bestComparableNetUsd,
    bestRawNetUsd:comparison.bestRawNetUsd,
    excludedByReason:comparison.excludedByReason,rules:{...this.config.freshness,
     minLiquidityUsd:this.config.minQuoteLiquidityUsd},
    comparableRoutes:comparison.comparableCandidates.slice(0,20),
    excludedRoutes:comparison.excludedCandidates.slice(0,12)},
   raydium:{status:r.status,poolCount:r.poolCount,quotes:r.quotes.length,
    readyPools:r.readyPools,events:r.events,progress:r.progress,
    lastUpdatedAt:r.lastUpdatedAt,errors:[...r.errors,...Object.entries(r.poolReasons).map(([key,value])=>key+': '+value)].slice(0,6)},
   clmm:{status:cl.status,selectedPools:cl.selectedPools,readyPools:cl.readyPools,
    quotes:cl.quotes.length,scans:cl.scans,perPool:cl.perPool,
    localEvents:cl.localEvents,localRecomputations:cl.localRecomputations,
    activeTickSubscriptions:cl.activeTickSubscriptions,slotVerifiedPools:cl.slotVerifiedPools,
    poolAccountEvents:cl.poolAccountEvents,selectiveScans:cl.selectiveScans,
    pendingDirtyPools:cl.pendingDirtyPools,
    lastUpdatedAt:cl.lastUpdatedAt,errors:cl.errors.slice(0,6)},
   c2:{
    enabled:this.config.c2LocalQuotesEnabled,
    orcaLocal:o.localPricing??null,
    referenceValidation:o.referenceValidation??null,
    clmmLocal:{scans:cl.scans,quotesFromCachedSdkState:cl.quotes.length,
     localEvents:cl.localEvents??0,localRecomputations:cl.localRecomputations??0,
     activeTickSubscriptions:cl.activeTickSubscriptions??0,
     slotVerifiedPools:cl.slotVerifiedPools??0},
    note:'Offline quotes use SDK mathematics from cached pool/tick state; reference comparisons use separate SDK/RPC contexts and are not execution proofs.'
   },
   orca:{status:o.status,poolCount:o.orcaPools,quotedLegs:o.quotedLegs.length,
    quoteState:o.quoteState,freshLegs:o.freshLegs,expiredLegs:o.expiredLegs,
    quoteMode:o.quoteMode,lastScanDurationMs:o.lastScanDurationMs,
    lastFirstBuyDelayMs:o.lastFirstBuyDelayMs,
    lastBuyCount:o.lastBuyCount,lastReverseCount:o.lastReverseCount,
    lastPoolSetupMs:o.lastPoolSetupMs,
    poolFreshness:o.poolFreshness,tickArraysSlotVerified:o.tickArraysSlotVerified,
    lastUpdatedAt:o.lastUpdatedAt,progress:o.progress,errors:o.errors.slice(0,6)},
   feed:{status:s.status,stalePools:s.pools.filter(p=>p.stale).length,
    lastPollAt:s.lastPollAt,errors:s.errors},
   jupiter:{status:this.jupiter.snapshot().status,
    lastFinishedAt:this.jupiter.snapshot().lastScanFinishedAt,
    bestNetUsd:this.jupiter.snapshot().observations.length?
     Math.max(...this.jupiter.snapshot().observations.map(p=>p.estimatedNetUsd)):null},
   rpc,history:this.histories.slice(-48),activity:this.events.slice(0,12),
   safety:'Read-only B5 research. Quotes are indicative; no simulated or executable trades.'
  };
 }
 getMarketData(){return this.marketData?.snapshot()??null;}
 getTopology(){return this.topology;}
 getDiscovered(){return {pools:[...this.pools],warnings:[...this.discoveryWarnings],
  validatedCount:this.discoveryValidated,lastUpdatedAt:this.lastDiscoveryAt};}
 getRaydium(){return this.ray.snapshot();}
 getOrca(){return this.orca.snapshot();}
 getClmm(){return this.clmm.snapshot();}
 getRunningStatus(){return {busy:this.busy,running:this.running};}
}
