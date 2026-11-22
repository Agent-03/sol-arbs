import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {decodeAmmV4AnyPair,decodeVault} from './ammV4.js';
import {RAYDIUM_AMM_V4,RAYDIUM_CLMM} from './routes.js';
import {C3Concentrated,type ConcentratedSnapshot} from './c3Concentrated.js';
import {MeteoraDlmmMonitor,type DlmmHealth} from './meteoraDlmm.js';
import {PoolInfoLayout} from '@raydium-io/raydium-sdk-v2';
import {RAYDIUM_CPMM,SPL_TOKEN_PROGRAM,CPMM_VAULT_AUTHORITY,
 decodeCpmmPool,decodeCpmmConfig,cpmmEffectiveReserves} from './c3Cpmm.js';
import {C3TokenDiscovery,type TokenDiscoveryHealth} from './c3TokenDiscovery.js';
import {C3PoolRegistry,type PoolRegistrySnapshot} from './c3PoolRegistry.js';
import {GRAPH_ASSETS,assetOfMint,replaceDynamicGraphAssets,evaluateGraphCycles,
 type GraphAsset,type GraphPool,type GraphEvaluation,type GraphScanLimits} from './c3Graph.js';
import type {MarketDataFeed} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AMM_AUTHORITY=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
type Candidate={address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number;
 program?:'raydium_amm_v4'|'raydium_cpmm'|'raydium_clmm'};
type Component={owner:string;data:Buffer;slot:number;at:number};
type PoolWatch={candidate:Candidate;keys:string[];components:Map<string,Component>;release:(()=>void)[]};
export type GraphMonitorOptions={
 enabled:boolean;maxPools:number;perPair:number;refreshMs:number;reconcileMs:number;
 sizesUsd:number[];maxPathChecks:number;maxResults:number;maxQuoteAgeMs:number;
 maxQuoteGapMs:number;maxSlotSkew:number;minLiquidityUsd:number;assumedCostUsd:number;
 maxPoolInputShareBps?:number;
 dynamicDiscoveryEnabled?:boolean;maxTokens?:number;tokenRefreshMs?:number;
 poolRequestBudget?:number;poolQueryConcurrency?:number;apiKey?:string;
 sizesSol?:number[];assumedCostSol?:number;
 registryEnabled?:boolean;registryTokensPerRefresh?:number;
 registryConcurrency?:number;registryMaxPools?:number;
 registryTtlMs?:number;registryMinLiquidityUsd?:number;
 dlmmEnabled?:boolean;dlmmMaxPools?:number;dlmmConcurrency?:number;
 dlmmRefreshMs?:number;dlmmMaxArraysPerSide?:number;
 dlmmRefreshBudget?:number;dlmmRefreshConcurrency?:number;
 dlmmRpcDeadlineMs?:number;dlmmReindexDeadlineMs?:number;
 dlmmReindexConcurrency?:number;
};
export type GraphMonitorSnapshot=GraphEvaluation&{
 status:'disabled'|'discovering'|'warming'|'monitoring'|'partial_error'|'stopped';
 trackedPools:number;watchedAccounts:number;rpcReconciles:number;
 discoveryStats:{apiCandidates:number;validatedV4:number;validatedCpmm:number;selected:number};
 wsUpdates:number;localEvaluations:number;lastDiscoveryAt?:string;
 concentrated:ConcentratedSnapshot;dlmm:DlmmHealth;tokenDiscovery:TokenDiscoveryHealth;
 poolRegistry:Omit<PoolRegistrySnapshot,'pools'|'tokens'>;
 dynamicPoolDiscovery:{pairQueries:number;rotation:number;queryBudget:number;queryConcurrency:number};
 lastReconcileAt?:string;errors:string[];
};
const baseline=(options:GraphMonitorOptions):GraphEvaluation=>
 evaluateGraphCycles([],{sizesUsd:options.sizesUsd,maxAgeMs:options.maxQuoteAgeMs,
  maxGapMs:options.maxQuoteGapMs,maxSlotSkew:options.maxSlotSkew,
  minLiquidityUsd:options.minLiquidityUsd,maxPathChecks:options.maxPathChecks,
  maxResults:options.maxResults,assumedCostUsd:options.assumedCostUsd,
  maxPoolInputShareBps:options.maxPoolInputShareBps,
  baseAsset:options.dynamicDiscoveryEnabled?'SOL':'USDC',
  sizesSol:options.sizesSol,assumedCostSol:options.assumedCostSol});

export function parseRaydiumGraphPair(result:unknown,a:GraphAsset,b:GraphAsset):Candidate[]{
 if(!result||typeof result!=='object')return [];
 const v=result as {success?:boolean;data?:{data?:unknown}};
 if(v.success!==true||!Array.isArray(v.data?.data))return [];
 if(!GRAPH_ASSETS[a]||!GRAPH_ASSETS[b])return [];
 const permitted=new Set([GRAPH_ASSETS[a].mint,GRAPH_ASSETS[b].mint]);
 const rows:Candidate[]=[];
 for(const raw of v.data.data){
  if(!raw||typeof raw!=='object')continue;
  const p=raw as {id?:unknown;mintA?:{address?:unknown};mintB?:{address?:unknown};tvl?:unknown};
  if(typeof p.id!=='string')continue;
  let pubkey:string;
  try{pubkey=new PublicKey(p.id).toBase58()}catch{continue}
  const ma=p.mintA?.address,mb=p.mintB?.address;
  if(typeof ma!=='string'||typeof mb!=='string'||!permitted.has(ma)||!permitted.has(mb)||ma===mb)continue;
  const tokenA=assetOfMint(ma),tokenB=assetOfMint(mb);
  if(!tokenA||!tokenB)continue;
  const liquidityUsd=Number(p.tvl);
  if(!Number.isFinite(liquidityUsd)||liquidityUsd<=0)continue;
  rows.push({address:pubkey,tokenA,tokenB,liquidityUsd});
 }
 return rows.sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
}
async function fetchPair(a:GraphAsset,b:GraphAsset,timeoutMs=8000):Promise<Candidate[]>{
 const u=new URL('https://api-v3.raydium.io/pools/info/mint');
 for(const [key,val] of Object.entries({mint1:GRAPH_ASSETS[a].mint,
  mint2:GRAPH_ASSETS[b].mint,poolType:'all',poolSortField:'liquidity',
  sortType:'desc',pageSize:'100',page:'1'}))u.searchParams.set(key,val);
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const r=await fetch(u,{headers:{accept:'application/json'},signal:controller.signal});
  if(!r.ok)throw new Error('Raydium API HTTP '+r.status);
  return parseRaydiumGraphPair(await r.json(),a,b);
 }finally{clearTimeout(timer)}
}
export class C3GraphMonitor{
 private running=false;private refreshing=false;private reconciling=false;
 private status:GraphMonitorSnapshot['status']='warming';
 private nodes=new Map<string,PoolWatch>();
 private byAccount=new Map<string,Set<string>>();
 private unsubscribe?:()=>void;
 private discoveryTimer?:ReturnType<typeof setInterval>;
 private reconcileTimer?:ReturnType<typeof setInterval>;
 private evaluationTimer?:ReturnType<typeof setTimeout>;
 private lastDiscoveryAt?:string;private lastReconcileAt?:string;
 private rpcReconciles=0;private wsUpdates=0;private localEvaluations=0;
 private discoveryStats={apiCandidates:0,validatedV4:0,validatedCpmm:0,selected:0};
 private errors:string[]=[];
 private evaluation:GraphEvaluation;
 private readonly concentrated:C3Concentrated;
 private readonly dlmm:MeteoraDlmmMonitor;
 private readonly tokenUniverse:C3TokenDiscovery;
 private readonly poolRegistry:C3PoolRegistry;
 private rotation=0;private lastPairQueries=0;
 private readonly clmmRegistry=new Map<string,{candidate:Candidate;lastSeen:number}>();
 constructor(private readonly rpc:Connection,private readonly feed:MarketDataFeed,
  private readonly options:GraphMonitorOptions){
  if(!Number.isSafeInteger(options.maxPools)||options.maxPools<1||options.maxPools>200||
   !Number.isSafeInteger(options.perPair)||options.perPair<1||options.perPair>10||
   !Number.isSafeInteger(options.refreshMs)||options.refreshMs<30000||
   !Number.isSafeInteger(options.reconcileMs)||options.reconcileMs<5000)
   throw new Error('Invalid C3 graph monitor configuration');
  if(options.dynamicDiscoveryEnabled&&(
   !Number.isSafeInteger(options.poolRequestBudget)||options.poolRequestBudget!<5||
   options.poolRequestBudget!>200||
   !Number.isSafeInteger(options.poolQueryConcurrency)||options.poolQueryConcurrency!<1||
   options.poolQueryConcurrency!>20))
   throw new Error('Invalid C3D query concurrency/budget');
  this.tokenUniverse=new C3TokenDiscovery(rpc,{
   enabled:!!options.dynamicDiscoveryEnabled,maxTokens:options.maxTokens??50,
   refreshMs:options.tokenRefreshMs??60000,apiKey:options.apiKey
  });
  this.poolRegistry=new C3PoolRegistry(rpc,{
   enabled:!!options.dynamicDiscoveryEnabled&&options.registryEnabled!==false,
   maxTokensPerRefresh:options.registryTokensPerRefresh??20,
   concurrency:options.registryConcurrency??6,
   refreshMs:Math.max(10000,options.refreshMs),
   minLiquidityUsd:options.registryMinLiquidityUsd??options.minLiquidityUsd,
   maxPools:options.registryMaxPools??350,
   ttlMs:options.registryTtlMs??20*60_000
  });
  this.evaluation=baseline(options);
  this.concentrated=new C3Concentrated(rpc,feed,{
   maxPools:Math.min(24,options.maxPools),perPair:Math.min(3,options.perPair),
   minLiquidityUsd:options.minLiquidityUsd,maxAgeMs:options.maxQuoteAgeMs,
   maxSlotSkew:options.maxSlotSkew,refreshMs:options.refreshMs
  },()=>this.scheduleEvaluation());
  this.dlmm=new MeteoraDlmmMonitor(rpc,feed,{
   enabled:!!options.dynamicDiscoveryEnabled&&!!options.dlmmEnabled,
   maxPools:options.dlmmMaxPools??16,
   maxAgeMs:options.maxQuoteAgeMs,maxSlotSkew:options.maxSlotSkew,
   refreshMs:options.dlmmRefreshMs??8000,
   concurrency:options.dlmmConcurrency??3,
   minLiquidityUsd:options.minLiquidityUsd,
   maxArraysPerSide:options.dlmmMaxArraysPerSide??3,
   refreshBudget:options.dlmmRefreshBudget??8,
   refreshConcurrency:options.dlmmRefreshConcurrency??4,
   rpcDeadlineMs:options.dlmmRpcDeadlineMs,
   reindexDeadlineMs:options.dlmmReindexDeadlineMs,
   reindexConcurrency:options.dlmmReindexConcurrency
  },()=>this.scheduleEvaluation());
  if(!options.enabled)this.status='disabled';
 }
 /** Refresh readiness against the same current account cache used by graph
  * edges when /api/c3/pools is requested. Do not publish a stale cached
  * "ready" state after a pool's bin arrays have aged out.
  */
 poolRegistrySnapshot():PoolRegistrySnapshot{
  const at=Date.now();
  const raydium=[...this.nodes.values()].map(n=>this.extract(n,at))
   .filter((p):p is GraphPool=>p!==null);
  const concentrated=this.concentrated.snapshot(at).pools;
  const dlmm=this.dlmm.graphPools(at);
  const reasons=new Map(this.dlmm.snapshot(at).perPool.map(p=>[
   p.address,p.reason??'awaiting_dlmm_local_quote_snapshot']));
  this.poolRegistry.observeReady([...raydium,...concentrated,...dlmm],reasons);
  return this.poolRegistry.snapshot();
 }
 snapshot():GraphMonitorSnapshot{
  const {pools:_registryPools,tokens:_registryTokens,...poolRegistry}=this.poolRegistry.snapshot();
  return {...this.evaluation,candidates:[...this.evaluation.candidates],
   status:this.status,trackedPools:this.nodes.size+this.concentrated.snapshot().health.trackedClmm+
    this.concentrated.snapshot().health.trackedOrca+this.dlmm.snapshot().tracked,
   watchedAccounts:this.byAccount.size,concentrated:this.concentrated.snapshot().health,
   dlmm:this.dlmm.snapshot(),
   tokenDiscovery:this.tokenUniverse.snapshot(),poolRegistry,
   dynamicPoolDiscovery:{pairQueries:this.lastPairQueries,rotation:this.rotation,
    queryBudget:this.options.poolRequestBudget??0,queryConcurrency:this.options.poolQueryConcurrency??1},
   rpcReconciles:this.rpcReconciles,wsUpdates:this.wsUpdates,
   discoveryStats:{...this.discoveryStats},
   localEvaluations:this.localEvaluations,lastDiscoveryAt:this.lastDiscoveryAt,
   lastReconcileAt:this.lastReconcileAt,errors:[...this.errors]};
 }
 private note(msg:string){this.errors.unshift(msg);this.errors=this.errors.slice(0,12);}
 private scheduleEvaluation(){
  if(!this.running||this.evaluationTimer)return;
  // Bursty WS notifications are coalesced into one local graph evaluation.
  this.evaluationTimer=setTimeout(()=>{
   this.evaluationTimer=undefined;
   if(this.running)this.evaluate();
  },35);
 }
 private extract(node:PoolWatch,now=Date.now()):GraphPool|null{
  const [pool,vaultA,vaultB]=node.keys;
  const parts=node.keys.map(key=>node.components.get(key));
  if(parts.some(x=>!x))return null;
  const states=parts as Component[];
  const cpmm=node.candidate.program==='raydium_cpmm';
  if(states[0].owner!==(cpmm?RAYDIUM_CPMM:RAYDIUM_AMM_V4)||
   states[1].owner!==TOKEN_PROGRAM||states[2].owner!==TOKEN_PROGRAM||
   (cpmm&&states[3]?.owner!==RAYDIUM_CPMM))return null;
  try{
   let a:GraphAsset|undefined,b:GraphAsset|undefined;
   let balanceA:bigint,balanceB:bigint,feeNumerator:string,feeDenominator:string;
   let creatorFeeRate:string|undefined,creatorFeeOn:0|1|2|undefined;
   if(cpmm){
    const state=decodeCpmmPool(states[0].data,Math.floor(now/1000));
    if(state.vaultA!==vaultA||state.vaultB!==vaultB||state.config!==node.keys[3])return null;
    a=assetOfMint(state.mintA);b=assetOfMint(state.mintB);
    const rawA=decodeVault(states[1].data,state.mintA,CPMM_VAULT_AUTHORITY);
    const rawB=decodeVault(states[2].data,state.mintB,CPMM_VAULT_AUTHORITY);
    ({reserveA:balanceA,reserveB:balanceB}=cpmmEffectiveReserves(state,rawA,rawB));
    const config=decodeCpmmConfig(states[3].data);
    feeNumerator=config.tradeFeeRate.toString();
    feeDenominator='1000000';
    creatorFeeRate=(state.creatorFeeEnabled?config.creatorFeeRate:0n).toString();
    creatorFeeOn=state.creatorFeeOn;
   }else{
    const state=decodeAmmV4AnyPair(pool,states[0].data);
    if(state.baseVault!==vaultA||state.quoteVault!==vaultB)return null;
    a=assetOfMint(state.baseMint);b=assetOfMint(state.quoteMint);
    balanceA=decodeVault(states[1].data,state.baseMint,AMM_AUTHORITY)-state.baseNeedTakePnl;
    balanceB=decodeVault(states[2].data,state.quoteMint,AMM_AUTHORITY)-state.quoteNeedTakePnl;
    feeNumerator=state.feeNumerator.toString();
    feeDenominator=state.feeDenominator.toString();
   }
   if(!a||!b||a===b||a!==node.candidate.tokenA||
    b!==node.candidate.tokenB||balanceA<=0n||balanceB<=0n)return null;
   const slots=states.map(x=>x.slot);
   const gap=Math.max(...slots)-Math.min(...slots),oldest=Math.min(...states.map(x=>x.at));
   if(gap>this.options.maxSlotSkew||now-oldest>this.options.maxQuoteAgeMs)return null;
   return {address:pool,program:cpmm?'raydium_cpmm':'raydium_amm_v4',
    tokenA:a,tokenB:b,reserveA:balanceA.toString(),reserveB:balanceB.toString(),
    feeNumerator,feeDenominator,creatorFeeRate,creatorFeeOn,
    observedAt:new Date(oldest).toISOString(),poolSlot:states[0].slot,
    vaultSlot:Math.min(states[1].slot,states[2].slot),
    liquidityUsd:node.candidate.liquidityUsd,
    snapshotIntegrity:'bounded_slot_research'};
  }catch{return null}
 }
 private evaluate(){
  const at=Date.now();
  const pools=[...this.nodes.values()].map(p=>this.extract(p,at)).filter((p):p is GraphPool=>p!==null);
  const extra=this.concentrated.snapshot(at);
  pools.push(...extra.pools);
  pools.push(...this.dlmm.graphPools(at));
  const reasons=new Map(this.dlmm.snapshot(at).perPool.map(p=>[
   p.address,p.reason??'awaiting_dlmm_local_quote_snapshot']));
  this.poolRegistry.observeReady(pools,reasons);
  const scanned=evaluateGraphCycles(pools,{
   sizesUsd:this.options.sizesUsd,maxAgeMs:this.options.maxQuoteAgeMs,
   maxGapMs:this.options.maxQuoteGapMs,maxSlotSkew:this.options.maxSlotSkew,
   minLiquidityUsd:this.options.minLiquidityUsd,maxPathChecks:this.options.maxPathChecks,
   maxResults:this.options.maxResults,assumedCostUsd:this.options.assumedCostUsd,
   maxPoolInputShareBps:this.options.maxPoolInputShareBps,
   baseAsset:this.options.dynamicDiscoveryEnabled?'SOL':'USDC',
   sizesSol:this.options.sizesSol,assumedCostSol:this.options.assumedCostSol
  },at);
  // Pools blocked by missing/stale components never reach evaluateGraphCycles.
  // Include them in coverage instead of misleadingly claiming zero stale pools.
  const tracked=this.nodes.size+extra.health.trackedClmm+extra.health.trackedOrca+
   this.dlmm.snapshot(at).tracked;
  this.evaluation={...scanned,poolCount:tracked,
   stalePools:scanned.stalePools+Math.max(0,tracked-pools.length)};
  this.localEvaluations++;
 }
 private detach(pool:string){
  const entry=this.nodes.get(pool);
  if(!entry)return;
  this.nodes.delete(pool);
  for(const key of entry.keys){
   const set=this.byAccount.get(key);
   set?.delete(pool);
   if(!set?.size)this.byAccount.delete(key);
  }
  entry.release.forEach(stop=>stop());
 }
 private attach(candidate:Candidate,info:AccountInfo<Buffer>,slot:number,now:number){
  if(!candidate.program)return;
  const cpmm=candidate.program==='raydium_cpmm';
  let keys:string[];
  if(cpmm){
   const state=decodeCpmmPool(info.data,Math.floor(now/1000));
   if(assetOfMint(state.mintA)!==candidate.tokenA||
    assetOfMint(state.mintB)!==candidate.tokenB)return;
   keys=[candidate.address,state.vaultA,state.vaultB,state.config];
  }else{
   const state=decodeAmmV4AnyPair(candidate.address,info.data);
   if(assetOfMint(state.baseMint)!==candidate.tokenA||
    assetOfMint(state.quoteMint)!==candidate.tokenB)return;
   keys=[candidate.address,state.baseVault,state.quoteVault];
  }
  const release:(()=>void)[]=[];
  try{
   const program=cpmm?RAYDIUM_CPMM:RAYDIUM_AMM_V4;
   keys.forEach((key,i)=>{
    this.feed.expectOwner(key,i===0||i===3?program:TOKEN_PROGRAM);
    release.push(this.feed.watch(key));
   });
   const entry:PoolWatch={candidate,keys,release,components:new Map()};
   this.nodes.set(candidate.address,entry);
   keys.forEach(key=>{
    const set=this.byAccount.get(key)??new Set<string>();
    set.add(candidate.address);this.byAccount.set(key,set);
   });
   entry.components.set(candidate.address,{owner:program,data:Buffer.from(info.data),slot,at:now});
   for(const key of keys){
    const prev=this.feed.get(key);
    if(prev&&prev.slot>=slot)entry.components.set(key,{owner:prev.owner,
     data:Buffer.from(prev.data),slot:prev.slot,at:prev.receivedAt});
   }
  }catch(error){release.forEach(stop=>stop());this.note('Attach failed: '+String(error))}
 }
 private async discover(){
  if(!this.running||this.refreshing)return;
  this.refreshing=true;this.status='discovering';
  try{
   const dynamic=!!this.options.dynamicDiscoveryEnabled;
   let pairs:Array<[GraphAsset,GraphAsset]>=[];
   let registryTask:Promise<void>|undefined;
   if(dynamic){
    await this.tokenUniverse.refresh();
    if(!this.running)return;
    const tokens=this.tokenUniverse.getTokens();
    // The pinned bridge assets already have dedicated anchor-pair queries.
    // Do not let USDC/USDT/JUP consume the rotating new-token query budget.
    const dynamicTokens=tokens.filter(t=>t.mint!==GRAPH_ASSETS.USDC.mint&&
     t.mint!==GRAPH_ASSETS.USDT.mint&&t.mint!==GRAPH_ASSETS.JUP.mint);
    replaceDynamicGraphAssets(tokens);
    this.concentrated.setAllowedMints(Object.values(GRAPH_ASSETS).map(x=>x.mint));
    // Run cross-DEX discovery simultaneously with Raydium pair metadata.
    // A bad third-party endpoint never blocks the existing graph scanner.
    registryTask=this.poolRegistry.refresh(dynamicTokens.map(t=>t.mint))
     .catch(error=>this.note('C3D.2 registry refresh: '+String(error)));
    // SOL is always the route root. USDC and USDT are bridge assets.
    const anchors:Array<[GraphAsset,GraphAsset]>=[
     ['SOL','USDC'],['SOL','USDT'],['USDC','USDT'],['SOL','JUP'],['USDC','JUP']
    ];
    const budget=this.options.poolRequestBudget??80;
    pairs.push(...anchors.slice(0,budget));
    // Retain the highest-priority five tokens every refresh, and rotate the
    // remainder. No top-token monopoly over the bounded API query budget.
    const capacity=Math.max(0,Math.floor((budget-pairs.length)/2));
    const priority=dynamicTokens.slice(0,Math.min(5,capacity));
    const rotating=dynamicTokens.slice(priority.length);
    const round=rotating.length?this.rotation%rotating.length:0;
    const selected=[...priority];
    for(let i=0;i<rotating.length&&selected.length<capacity;i++)
     selected.push(rotating[(round+i)%rotating.length]);
    this.rotation+=Math.max(1,capacity-priority.length);
    for(const token of selected){
     pairs.push(['SOL',token.mint],['USDC',token.mint]);
    }
   }else{
    const assets=Object.keys(GRAPH_ASSETS) as GraphAsset[];
    for(let i=0;i<assets.length;i++)for(let j=i+1;j<assets.length;j++)
     pairs.push([assets[i],assets[j]]);
   }
   const results:Array<PromiseSettledResult<Candidate[]>>=new Array(pairs.length);
   let cursor=0;
   const workers=Math.min(pairs.length,this.options.poolQueryConcurrency??6);
   await Promise.all(Array.from({length:workers},async()=>{
    while(cursor<pairs.length){
     const i=cursor++;
     try{results[i]={status:'fulfilled',value:await fetchPair(...pairs[i])}}
     catch(reason){results[i]={status:'rejected',reason}}
    }
   }));
   this.lastPairQueries=pairs.length;
   if(!this.running)return;
   const buckets:Candidate[][]=[];
   results.forEach((result,i)=>{
    if(result.status==='fulfilled')
     buckets.push(result.value.filter(x=>x.liquidityUsd>=this.options.minLiquidityUsd));
    else{
     buckets.push([]);
     this.note('Raydium '+pairs[i].join('/')+' discovery: '+String(result.reason));
    }
   });
   if(registryTask)await registryTask;
   if(!this.running)return;
   // Owner+mint-verified registry pools extend Raydium pair discovery.
   // Other venues are mapped separately, never injected into V4/CPMM math.
   const registry=this.poolRegistry.supported();
   this.dlmm.setCandidates(registry.filter(x=>x.program==='meteora_dlmm'));
   const supplementary=new Map<string,Candidate[]>();
   for(const item of registry)if(item.venue==='raydium'){
    const a=assetOfMint(item.mintA),b=assetOfMint(item.mintB);
    if(!a||!b||a===b)continue;
    const candidate:Candidate={address:item.address,tokenA:a,tokenB:b,
     liquidityUsd:item.liquidityUsd,program:item.program as Candidate['program']};
    const group=[a,b].sort().join(':');
    const rows=supplementary.get(group)??[];
    rows.push(candidate);supplementary.set(group,rows);
   }
   for(const group of supplementary.values()){
    group.sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
    buckets.push(group);
   }
   this.concentrated.setRegistryOrcaCandidates(registry
    .filter(x=>x.venue==='orca'&&x.program==='orca_whirlpool')
    .flatMap(x=>{
     const a=assetOfMint(x.mintA),b=assetOfMint(x.mintB);
     return a&&b&&a!==b?[{address:x.address,tokenA:a,tokenB:b,
      liquidityUsd:x.liquidityUsd}]:[];
    }));
   const unique=new Map<string,Candidate>();
   for(const bucket of buckets)for(const candidate of bucket)
    if(!unique.has(candidate.address))unique.set(candidate.address,candidate);
   if(!unique.size){
    this.note('No Raydium candidates in current rotating query window; retaining earlier watched pools');
    this.status=this.nodes.size?'monitoring':'partial_error';return;
   }
   const entries=[...unique.values()];
   this.discoveryStats={apiCandidates:entries.length,validatedV4:0,validatedCpmm:0,selected:0};
   type Verified={candidate:Candidate;info:AccountInfo<Buffer>;slot:number};
   const validated=new Map<string,Verified>();
   for(let start=0;start<entries.length;start+=75){
    const block=entries.slice(start,start+75);
    const response=await this.rpc.getMultipleAccountsInfoAndContext(
     block.map(p=>new PublicKey(p.address)),'confirmed');
    if(!this.running)return;
    response.value.forEach((info,i)=>{
     if(!info||info.executable)return;
     const owner=info.owner.toBase58();
     if(owner!==RAYDIUM_AMM_V4&&owner!==RAYDIUM_CPMM&&owner!==RAYDIUM_CLMM)return;
     const candidate=block[i];
     try{
      const mints=owner===RAYDIUM_CPMM
       ?(()=>{const s=decodeCpmmPool(info.data);return [s.mintA,s.mintB] as const})()
       :owner===RAYDIUM_CLMM
       ?(()=>{const state=PoolInfoLayout.decode(info.data);
          return [state.mintA.toBase58(),state.mintB.toBase58()] as const})()
       :(()=>{const s=decodeAmmV4AnyPair(candidate.address,info.data);
          return [s.baseMint,s.quoteMint] as const})();
      const a=assetOfMint(mints[0]),b=assetOfMint(mints[1]);
      if(!a||!b||!(a===candidate.tokenA&&b===candidate.tokenB||
                      b===candidate.tokenA&&a===candidate.tokenB))return;
      validated.set(candidate.address,{candidate:{...candidate,tokenA:a,tokenB:b,
       program:owner===RAYDIUM_CPMM?'raydium_cpmm':
        owner===RAYDIUM_CLMM?'raydium_clmm':'raydium_amm_v4'},
       info,slot:response.context.slot});
     }catch{/* On-chain layout/program incompatibility excludes pool. */}
    });
   }
   this.discoveryStats.validatedV4=[...validated.values()]
    .filter(x=>x.candidate.program==='raydium_amm_v4').length;
   this.discoveryStats.validatedCpmm=[...validated.values()]
    .filter(x=>x.candidate.program==='raydium_cpmm').length;
   const active=new Set(Object.keys(GRAPH_ASSETS));
   const clmmNew=[...validated.values()].filter(x=>x.candidate.program==='raydium_clmm');
   if(dynamic){
    for(const [addr,row] of this.clmmRegistry)
     if(!active.has(row.candidate.tokenA)||!active.has(row.candidate.tokenB)||
        Date.now()-row.lastSeen>10*60_000)this.clmmRegistry.delete(addr);
   }else this.clmmRegistry.clear();
   for(const item of clmmNew)
    this.clmmRegistry.set(item.candidate.address,{candidate:item.candidate,lastSeen:Date.now()});
   const clmmCandidates=[...this.clmmRegistry.values()]
    .sort((a,b)=>b.candidate.liquidityUsd-a.candidate.liquidityUsd)
    .slice(0,24).map(x=>({
     address:x.candidate.address,tokenA:x.candidate.tokenA,
     tokenB:x.candidate.tokenB,liquidityUsd:x.candidate.liquidityUsd
    }));
   void this.concentrated.setRaydiumCandidates(clmmCandidates)
    .catch(error=>this.note('C3D CLMM bootstrap: '+String(error)));
   const perPair=buckets.map(bucket=>bucket.flatMap(x=>{
    const row=validated.get(x.address);
    return row&&row.candidate.program!=='raydium_clmm'?[row]:[];
   }).slice(0,this.options.perPair));
   const picked:Verified[]=[],seen=new Set<string>();
   for(let tier=0;tier<this.options.perPair;tier++){
    for(const bucket of perPair){
     if(picked.length>=this.options.maxPools)break;
     const result=bucket[tier];
     if(result&&!seen.has(result.candidate.address)){
      seen.add(result.candidate.address);picked.push(result);
     }
    }
    if(picked.length>=this.options.maxPools)break;
   }
   this.discoveryStats.selected=picked.length;
   const wanted=new Set<string>();
   for(const result of picked){
    if(!this.running)return;
    const {candidate,info,slot}=result;
    wanted.add(candidate.address);
    if(this.nodes.has(candidate.address))
     this.nodes.get(candidate.address)!.candidate=candidate;
    else this.attach(candidate,info,slot,Date.now());
   }
   // Rotation must never drop an otherwise valid pool simply because its
   // token was not included in this cycle's bounded Raydium API window.
   if(dynamic)for(const [id,node] of this.nodes){
    if(wanted.size>=this.options.maxPools)break;
    if(active.has(node.candidate.tokenA)&&active.has(node.candidate.tokenB))
     wanted.add(id);
   }
   for(const id of [...this.nodes.keys()])if(!wanted.has(id))this.detach(id);
   this.lastDiscoveryAt=new Date().toISOString();
   await this.reconcile();
   this.status=this.nodes.size||clmmCandidates.length?'monitoring':'partial_error';
  }catch(error){this.note('C3D discovery: '+String(error));this.status='partial_error'}
  finally{this.refreshing=false;this.scheduleEvaluation()}
 }
 private async reconcile(){
  if(!this.running||this.reconciling||!this.nodes.size)return;
  this.reconciling=true;
  try{
   const addresses=[...this.byAccount.keys()];
   for(let start=0;start<addresses.length;start+=75){
    const batch=addresses.slice(start,start+75);
    const response=await this.rpc.getMultipleAccountsInfoAndContext(
     batch.map(x=>new PublicKey(x)),'confirmed');
    if(!this.running)return;
    const at=Date.now();
    response.value.forEach((info,i)=>{
     if(!info)return;
     const key=batch[i],owner=info.owner.toBase58();
     for(const pool of this.byAccount.get(key)??[]){
      const node=this.nodes.get(pool);
      if(!node)continue;
      const current=node.components.get(key);
      if(current&&current.slot>response.context.slot)continue;
      node.components.set(key,{owner,data:Buffer.from(info.data),slot:response.context.slot,at});
     }
    });
   }
   this.rpcReconciles++;this.lastReconcileAt=new Date().toISOString();
  }catch(error){this.note('C3B reconcile: '+String(error));this.status='partial_error'}
  finally{this.reconciling=false;this.scheduleEvaluation()}
 }
 async start(){
  if(this.running||!this.options.enabled)return;
  this.running=true;
  this.concentrated.start();this.dlmm.start();
  this.unsubscribe=this.feed.onUpdate(update=>{
   if(!this.running)return;
   const related=this.byAccount.get(update.address);
   if(!related)return;
   this.wsUpdates++;
   for(const id of related){
    const node=this.nodes.get(id);if(!node)continue;
    const prior=node.components.get(update.address);
    if(prior&&update.slot<prior.slot)continue;
    node.components.set(update.address,{owner:update.owner,data:Buffer.from(update.data),
     slot:update.slot,at:update.receivedAt});
   }
   this.scheduleEvaluation();
  });
  await this.discover();
  if(!this.running)return;
  this.discoveryTimer=setInterval(()=>{void this.discover()},this.options.refreshMs);
  this.reconcileTimer=setInterval(()=>{void this.reconcile()},this.options.reconcileMs);
 }
 stop(){
  this.running=false;
  if(this.discoveryTimer)clearInterval(this.discoveryTimer);
  if(this.reconcileTimer)clearInterval(this.reconcileTimer);
  if(this.evaluationTimer)clearTimeout(this.evaluationTimer);
  this.unsubscribe?.();this.unsubscribe=undefined;
  this.concentrated.stop();this.dlmm.stop();this.poolRegistry.stop();
  for(const key of [...this.nodes.keys()])this.detach(key);
  this.status='stopped';
 }
}
