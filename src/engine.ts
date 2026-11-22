import {PublicKey,type Connection} from '@solana/web3.js';
import {discoverPools,type DiscoveredPool} from './discovery.js';
import {AmmV4Monitor} from './ammV4.js';
import {OrcaMonitor} from './orca.js';
import {buildCandidates,RAYDIUM_AMM_V4,ORCA_WHIRLPOOL,RAYDIUM_CLMM} from './routes.js';
import {assessRoutes,type RouteSummary} from './opportunities.js';
import {Scanner} from './scanner.js';
import type {Config} from './config.js';
import type {RpcProviderPool} from './rpcFailover.js';
import type {JupiterMonitor} from './jupiter.js';

type Activity={id:number;at:string;level:'info'|'success'|'warning';kind:string;message:string};
type History={at:string;comparable:number;positive:number;excluded:number;bestNetUsd:number|null;total:number};
type Busy='idle'|'quoting'|'discovering';

export class MarketEngine {
 private readonly pools:DiscoveredPool[];
 private topology:ReturnType<typeof buildCandidates>;
 private readonly ray:AmmV4Monitor;
 private readonly orca:OrcaMonitor;
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
 private lastManualDiscoveryAt=0;
 private events:Activity[]=[];
 private histories:History[]=[];
 private eventId=0;
 private lastNetPositive=false;
 private previousRateLimits=0;
 private previousFailovers=0;

 constructor(
  private readonly conn:Connection,
  private readonly config:Config,
  private readonly scanner:Scanner,
  private readonly rpc:RpcProviderPool,
  private readonly jupiter:JupiterMonitor,
  discovered:Awaited<ReturnType<typeof discoverPools>>,
  private readonly manualPools:PublicKey[]
 ){
  this.pools=[...discovered.pools];
  this.topology=buildCandidates(this.pools);
  this.discoveryWarnings=discovered.warnings;
  this.discoveryValidated=discovered.validatedCount??discovered.pools.length;
  this.lastDiscoveryAt=new Date().toISOString();
  this.lastDiscoveryAttempt=Date.now();
  this.ray=new AmmV4Monitor(conn,this.pools,config.jupiter.sizesUsd,config.ammScanIntervalMs,config.ammMaxSlotSkew,config.minQuoteLiquidityUsd);
  this.orca=new OrcaMonitor(conn,this.pools,config.jupiter.sizesUsd,
   ()=>this.ray.snapshot().quotes,config.jupiter.assumedCostUsd,config.orcaScanIntervalMs,config.minQuoteLiquidityUsd);
  this.note('info','startup','Monitoring initialized for SOL/USDC. No execution or wallet operations enabled.');
 }
 private note(level:Activity['level'],kind:string,message:string){
  this.events.unshift({id:++this.eventId,at:new Date().toISOString(),level,kind,message});
  this.events=this.events.slice(0,24);
 }
 private scanInterval():number {
  return Math.max(this.config.ammScanIntervalMs,this.config.orcaScanIntervalMs);
 }
 private discoveryInterval():number{
  return this.lastNetPositive?this.config.discoveryRefreshMs:this.config.noProfitDiscoveryMs;
 }
 private schedule(delayMs=this.scanInterval()){
  if(!this.running)return;
  if(this.timer)clearTimeout(this.timer);
  this.nextScanAt=new Date(Date.now()+delayMs).toISOString();
  this.timer=setTimeout(()=>{void this.scan('scheduled');},delayMs);
 }
 private readonly minManualScanMs=30000;
 private readonly minManualDiscoveryMs=120000;

 async start(){
  if(this.running)return;
  this.running=true;
  await this.scanner.start();
  this.note('success','monitor','WebSocket/poll monitoring active; initial quote cycle scheduled.');
  this.schedule(100);
 }
 async stop(){
  this.running=false;
  if(this.timer)clearTimeout(this.timer);
  this.ray.stop();this.orca.stop();
  await this.scanner.stop();
 }
 requestScan():{accepted:boolean;message:string}{
  if(!this.running)return {accepted:false,message:'Scanner is not started'};
  if(this.busy!=='idle')return {accepted:false,message:'A scan or discovery refresh is already running'};
  const left=this.minManualScanMs-(Date.now()-this.lastManualScanAt);
  if(left>0)return {accepted:false,message:'Scan cooldown: '+Math.ceil(left/1000)+'s remaining'};
  this.lastManualScanAt=Date.now();
  if(this.timer)clearTimeout(this.timer);
  void this.scan('manual');
  return {accepted:true,message:'Fresh Raydium and Orca quote cycle requested'};
 }
 requestDiscovery():{accepted:boolean;message:string}{
  if(!this.running)return {accepted:false,message:'Scanner is not started'};
  if(this.busy!=='idle')return {accepted:false,message:'A scan or discovery refresh is already running'};
  const left=this.minManualDiscoveryMs-(Date.now()-this.lastManualDiscoveryAt);
  if(left>0)return {accepted:false,message:'Discovery cooldown: '+Math.ceil(left/1000)+'s remaining'};
  this.lastManualDiscoveryAt=Date.now();
  if(this.timer)clearTimeout(this.timer);
  void this.discoverAndResume('manual');
  return {accepted:true,message:'Refreshing supported SOL/USDC pool universe'};
 }
 private async discoverAndResume(reason:string){
  if(this.busy!=='idle')return;
  this.busy='discovering';
  try{await this.refreshUniverse(reason);}
  catch(error){
   this.discoveryStatus='partial_error';
   this.discoveryWarnings=[String(error)];
   this.note('warning','discovery','Discovery refresh failed; retaining previous pools');
  }finally{
   this.busy='idle';
   this.schedule(2000);
  }
 }
 private async refreshUniverse(reason:string){
  this.busy='discovering';
  this.lastDiscoveryAttempt=Date.now();
  this.lastDiscoveryReason=reason;
  this.note('info','discovery',reason==='manual'?'Manual pool discovery started':reason==='no_fresh_profitable_routes'?'No positive comparable routes; checking a wider SOL/USDC pool universe':'Scheduled SOL/USDC pool discovery started');
  // rotate secondary quote-supported pools when their full universe has more
  // than the active per-venue cap; keep the highest-liquidity anchors.
  const result=await discoverPools(this.conn,this.manualPools,this.config.maxPools,this.discoveryRuns);
  this.discoveryRuns++;
  this.discoveryWarnings=result.warnings;
  this.discoveryValidated=result.validatedCount??result.pools.length;
  if(!result.pools.length){
   this.discoveryStatus='partial_error';
   this.note('warning','discovery','Pool sources returned no validated pools; kept previous universe');
   return;
  }
  const oldHasBoth=this.pools.some(p=>p.owner===RAYDIUM_AMM_V4)&&this.pools.some(p=>p.owner===ORCA_WHIRLPOOL);
  const newHasBoth=result.pools.some(p=>p.owner===RAYDIUM_AMM_V4)&&result.pools.some(p=>p.owner===ORCA_WHIRLPOOL);
  if(oldHasBoth&&!newHasBoth){
   this.discoveryStatus='partial_error';
   this.note('warning','discovery','Discovery missing a required DEX; retained the last working pool universe');
   return;
  }
  const previous=new Set(this.pools.map(p=>p.address));
  const next=new Set(result.pools.map(p=>p.address));
  this.discoveryAdded=[...next].filter(x=>!previous.has(x)).length;
  this.discoveryRemoved=[...previous].filter(x=>!next.has(x)).length;
  await this.scanner.replacePools(result.pools.map(p=>new PublicKey(p.address)));
  this.pools.splice(0,this.pools.length,...result.pools);
  this.topology=buildCandidates(this.pools);
  this.lastDiscoveryAt=new Date().toISOString();
  this.discoveryStatus=result.warnings.length?'partial_error':'ok';
  this.note(this.discoveryStatus==='ok'?'success':'warning','discovery',
   'Universe refreshed: '+this.pools.length+' pools, '+this.discoveryAdded+' added, '+this.discoveryRemoved+' removed');
 }
 private async scan(reason:string){
  if(!this.running||this.busy!=='idle')return;
  this.busy='quoting';
  const began=Date.now();
  this.lastScanStartedAt=new Date(began).toISOString();
  this.nextScanAt=undefined;
  this.note('info','scan',reason==='manual'?'Manual quote scan started':'Automatic Raydium → Orca quote scan started');
  try{
   // Synchronized orchestration avoids racing the first Orca scan against
   // an empty Raydium snapshot; quote reads themselves are NOT atomic.
   await this.ray.scanOnce();
   if(!this.running)return;
   await this.orca.scanOnce();
   const x=this.assessment();
   this.lastNetPositive=x.positiveComparable>0;
   this.cycles++;
   this.lastScanAt=new Date().toISOString();
   this.lastScanDurationMs=Date.now()-began;
   this.histories.push({at:this.lastScanAt,comparable:x.comparable,positive:x.positiveComparable,
    excluded:x.excluded,bestNetUsd:x.bestComparableNetUsd,total:x.total});
   this.histories=this.histories.slice(-48);
   const network=this.rpc.snapshot();
   const rateLimits=(network.primary.rateLimits??0)+(network.secondary?.rateLimits??0);
   if(rateLimits>this.previousRateLimits){
    this.note('warning','rpc','Provider rate limits increased by '+(rateLimits-this.previousRateLimits)+' during quote monitoring');
   }
   if(network.failovers>this.previousFailovers){
    this.note('info','rpc',(network.failovers-this.previousFailovers)+' HTTP request(s) sent to the backup provider');
   }
   this.previousRateLimits=rateLimits;
   this.previousFailovers=network.failovers;
   if(x.positiveComparable>0){
    this.note('success','scan',x.positiveComparable+' positive research-only comparisons; all remain non-executable');
   }else if(!x.total){
    this.note('warning','scan','No complete cross-DEX routes; inspect Raydium/Orca errors and RPC health');
   }else if(!x.comparable){
    this.note('warning','scan','All '+x.total+' routes excluded by freshness, slot skew, or liquidity checks');
   }else{
    this.note('info','scan',x.comparable+' comparable routes; none positive after assumed costs');
   }
   const due=Date.now()-Math.max(this.lastDiscoveryAttempt,Date.parse(this.lastDiscoveryAt))>=this.discoveryInterval();
   if(this.running&&due){
    try{await this.refreshUniverse(this.lastNetPositive?'scheduled':'no_fresh_profitable_routes');}
    catch(error){
     this.discoveryStatus='partial_error';this.discoveryWarnings=[String(error)];
     this.note('warning','discovery','Discovery failed; existing pool set retained');
    }
   }
  }catch(error){
   this.note('warning','scan','Quote cycle encountered an error: '+String(error));
  }finally{
   this.busy='idle';
   if(this.running)this.schedule();
  }
 }
 assessment():RouteSummary{
  const raw=this.orca.snapshot().routeCandidates;
  return assessRoutes(raw,{...this.config.freshness,minLiquidityUsd:this.config.minQuoteLiquidityUsd});
 }
 dashboard(){
  const quote=this.assessment();
  const r=this.ray.snapshot(),o=this.orca.snapshot(),s=this.scanner.snapshot();
  const programCounts={
   raydiumV4:this.pools.filter(p=>p.owner===RAYDIUM_AMM_V4).length,
   orcaWhirlpool:this.pools.filter(p=>p.owner===ORCA_WHIRLPOOL).length,
   raydiumClmmUnsupported:this.pools.filter(p=>p.owner===RAYDIUM_CLMM).length
  };
  return {
   phase:'B4',mode:'READ_ONLY',now:new Date().toISOString(),market:'SOL/USDC',
   status:this.busy==='idle'?'monitoring':this.busy,
   scan:{status:this.busy,lastStartedAt:this.lastScanStartedAt,lastFinishedAt:this.lastScanAt,
    lastDurationMs:this.lastScanDurationMs,completedCycles:this.cycles,
    intervalMs:this.scanInterval(),nextAt:this.nextScanAt},
   discovery:{status:this.discoveryStatus,lastAt:this.lastDiscoveryAt,
    nextAt:new Date(Math.max(this.lastDiscoveryAttempt,Date.parse(this.lastDiscoveryAt))+this.discoveryInterval()).toISOString(),
    intervalMs:this.discoveryInterval(),reason:this.lastDiscoveryReason,
    validatedCandidates:this.discoveryValidated,trackedPools:this.pools.length,
    newlyAdded:this.discoveryAdded,removed:this.discoveryRemoved,
    quoteSupportedPools:this.pools.filter(p=>[RAYDIUM_AMM_V4,ORCA_WHIRLPOOL].includes(p.owner) && (p.liquidityUsd===undefined||p.liquidityUsd>=this.config.minQuoteLiquidityUsd)).length,
    lowLiquidityExcluded:this.pools.filter(p=>[RAYDIUM_AMM_V4,ORCA_WHIRLPOOL].includes(p.owner) && p.liquidityUsd!==undefined && p.liquidityUsd<this.config.minQuoteLiquidityUsd).length,
    coverage:programCounts,
    theoreticalTopologies:this.topology.candidates.length,
    warnings:this.discoveryWarnings},
   opportunities:{total:quote.total,comparable:quote.comparable,excluded:quote.excluded,
    positive:quote.positiveComparable,negative:quote.negativeComparable,
    bestComparableNetUsd:quote.bestComparableNetUsd,bestRawNetUsd:quote.bestRawNetUsd,
    excludedByReason:quote.excludedByReason,rules:{...this.config.freshness,
      minLiquidityUsd:this.config.minQuoteLiquidityUsd},
    comparableRoutes:quote.comparableCandidates.slice(0,20),
    excludedRoutes:quote.excludedCandidates.slice(0,12)},
   raydium:{status:r.status,poolCount:r.poolCount,quotes:r.quotes.length,
    lastUpdatedAt:r.lastUpdatedAt,progress:r.progress,errors:r.errors.slice(0,6)},
   orca:{status:o.status,poolCount:o.orcaPools,quotedLegs:o.quotedLegs.length,
    lastUpdatedAt:o.lastUpdatedAt,progress:o.progress,errors:o.errors.slice(0,6)},
   feed:{status:s.status,stalePools:s.pools.filter(p=>p.stale).length,
    lastPollAt:s.lastPollAt,errors:s.errors},
   jupiter:{status:this.jupiter.snapshot().status,
    lastFinishedAt:this.jupiter.snapshot().lastScanFinishedAt,
    bestNetUsd:this.jupiter.snapshot().observations.length?
    Math.max(...this.jupiter.snapshot().observations.map(p=>p.estimatedNetUsd)):null},
   rpc:this.rpc.snapshot(),history:this.histories.slice(-48),activity:this.events.slice(0,12),
   safety:'Comparison-only, not atomic or simulated; no transactions, wallets, or guaranteed profits.'
  };
 }
 getTopology(){return this.topology;}
 getDiscovered(){return {pools:[...this.pools],warnings:[...this.discoveryWarnings],
  validatedCount:this.discoveryValidated,lastUpdatedAt:this.lastDiscoveryAt};}
 getRaydium(){return this.ray.snapshot();}
 getOrca(){return this.orca.snapshot();}
 getRunningStatus(){return {busy:this.busy,running:this.running};}
}
