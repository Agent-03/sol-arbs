import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {decodeAmmV4AnyPair,decodeVault} from './ammV4.js';
import {RAYDIUM_AMM_V4} from './routes.js';
import {RAYDIUM_CPMM,SPL_TOKEN_PROGRAM,CPMM_VAULT_AUTHORITY,
 decodeCpmmPool,decodeCpmmConfig,cpmmEffectiveReserves} from './c3Cpmm.js';
import {GRAPH_ASSETS,assetOfMint,evaluateGraphCycles,
 type GraphAsset,type GraphPool,type GraphEvaluation,type GraphScanLimits} from './c3Graph.js';
import type {MarketDataFeed} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AMM_AUTHORITY=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
type Candidate={address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number;
 program?:'raydium_amm_v4'|'raydium_cpmm'};
type Component={owner:string;data:Buffer;slot:number;at:number};
type PoolWatch={candidate:Candidate;keys:string[];components:Map<string,Component>;release:(()=>void)[]};
export type GraphMonitorOptions={
 enabled:boolean;maxPools:number;perPair:number;refreshMs:number;reconcileMs:number;
 sizesUsd:number[];maxPathChecks:number;maxResults:number;maxQuoteAgeMs:number;
 maxQuoteGapMs:number;maxSlotSkew:number;minLiquidityUsd:number;assumedCostUsd:number;
 maxPoolInputShareBps?:number;
};
export type GraphMonitorSnapshot=GraphEvaluation&{
 status:'disabled'|'discovering'|'warming'|'monitoring'|'partial_error'|'stopped';
 trackedPools:number;watchedAccounts:number;rpcReconciles:number;
 discoveryStats:{apiCandidates:number;validatedV4:number;validatedCpmm:number;selected:number};
 wsUpdates:number;localEvaluations:number;lastDiscoveryAt?:string;
 lastReconcileAt?:string;errors:string[];
};
const baseline=(options:GraphMonitorOptions):GraphEvaluation=>
 evaluateGraphCycles([],{sizesUsd:options.sizesUsd,maxAgeMs:options.maxQuoteAgeMs,
  maxGapMs:options.maxQuoteGapMs,maxSlotSkew:options.maxSlotSkew,
  minLiquidityUsd:options.minLiquidityUsd,maxPathChecks:options.maxPathChecks,
  maxResults:options.maxResults,assumedCostUsd:options.assumedCostUsd,
  maxPoolInputShareBps:options.maxPoolInputShareBps});

export function parseRaydiumGraphPair(result:unknown,a:GraphAsset,b:GraphAsset):Candidate[]{
 if(!result||typeof result!=='object')return [];
 const v=result as {success?:boolean;data?:{data?:unknown}};
 if(v.success!==true||!Array.isArray(v.data?.data))return [];
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
 constructor(private readonly rpc:Connection,private readonly feed:MarketDataFeed,
  private readonly options:GraphMonitorOptions){
  if(!Number.isSafeInteger(options.maxPools)||options.maxPools<1||options.maxPools>24||
   !Number.isSafeInteger(options.perPair)||options.perPair<1||options.perPair>10||
   !Number.isSafeInteger(options.refreshMs)||options.refreshMs<60000||
   !Number.isSafeInteger(options.reconcileMs)||options.reconcileMs<5000)
   throw new Error('Invalid C3 graph monitor configuration');
  this.evaluation=baseline(options);
  if(!options.enabled)this.status='disabled';
 }
 snapshot():GraphMonitorSnapshot{
  return {...this.evaluation,candidates:[...this.evaluation.candidates],
   status:this.status,trackedPools:this.nodes.size,watchedAccounts:this.byAccount.size,
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
  const scanned=evaluateGraphCycles(pools,{
   sizesUsd:this.options.sizesUsd,maxAgeMs:this.options.maxQuoteAgeMs,
   maxGapMs:this.options.maxQuoteGapMs,maxSlotSkew:this.options.maxSlotSkew,
   minLiquidityUsd:this.options.minLiquidityUsd,maxPathChecks:this.options.maxPathChecks,
   maxResults:this.options.maxResults,assumedCostUsd:this.options.assumedCostUsd,
    maxPoolInputShareBps:this.options.maxPoolInputShareBps
  },at);
  // Pools blocked by missing/stale components never reach evaluateGraphCycles.
  // Include them in coverage instead of misleadingly claiming zero stale pools.
  this.evaluation={...scanned,poolCount:this.nodes.size,
   stalePools:scanned.stalePools+Math.max(0,this.nodes.size-pools.length)};
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
  this.refreshing=true;
  this.status='discovering';
  try{
   const assets=Object.keys(GRAPH_ASSETS) as GraphAsset[];
   const pairs:Array<[GraphAsset,GraphAsset]>=[];
   for(let i=0;i<assets.length;i++)for(let j=i+1;j<assets.length;j++)
    pairs.push([assets[i],assets[j]]);
   const results=await Promise.allSettled(pairs.map(([a,b])=>fetchPair(a,b)));
   if(!this.running)return;
   const buckets:Candidate[][]=[];
   results.forEach((result,i)=>{
    if(result.status==='fulfilled'){
     // Do not select the top 3 Raydium results yet: the public endpoint mixes
     // AMM V4, CPMM and CLMM. Validate program ownership FIRST so a few
     // high-liquidity CLMMs do not hide legitimate V4 pools.
     buckets.push(result.value.filter(x=>x.liquidityUsd>=this.options.minLiquidityUsd));
    }else{
     buckets.push([]);
     this.note('Raydium '+pairs[i].join('/')+' discovery: '+String(result.reason));
    }
   });
   const unique=new Map<string,Candidate>();
   for(const bucket of buckets)for(const candidate of bucket)
    if(!unique.has(candidate.address))unique.set(candidate.address,candidate);
   if(!unique.size){
    this.note('No pool candidates passed the pair and liquidity filters');
    this.status='partial_error';return;
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
     if(!info)return;
     const owner=info.owner.toBase58();
     if(owner!==RAYDIUM_AMM_V4&&owner!==RAYDIUM_CPMM)return;
     const candidate=block[i];
     try{
      const state=owner===RAYDIUM_CPMM
       ?decodeCpmmPool(info.data)
       :decodeAmmV4AnyPair(candidate.address,info.data);
      const onchainA=assetOfMint(owner===RAYDIUM_CPMM?state.mintA:state.baseMint);
      const onchainB=assetOfMint(owner===RAYDIUM_CPMM?state.mintB:state.quoteMint);
      if(!onchainA||!onchainB||
       !(onchainA===candidate.tokenA&&onchainB===candidate.tokenB||
         onchainB===candidate.tokenA&&onchainA===candidate.tokenB))return;
      validated.set(candidate.address,{
       candidate:{...candidate,tokenA:onchainA,tokenB:onchainB,
        program:owner===RAYDIUM_CPMM?'raydium_cpmm':'raydium_amm_v4'},
       info,slot:response.context.slot
      });
     }catch{/* unsupported, disabled or differently encoded pool */}
    });
   }
   this.discoveryStats.validatedV4=[...validated.values()]
    .filter(v=>v.candidate.program==='raydium_amm_v4').length;
   this.discoveryStats.validatedCpmm=[...validated.values()]
    .filter(v=>v.candidate.program==='raydium_cpmm').length;
   const perPair=buckets.map(bucket=>bucket.flatMap(x=>{
    const result=validated.get(x.address);
    return result?[result]:[];
   }).slice(0,this.options.perPair));
   const picked:Verified[]=[];const seen=new Set<string>();
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
   if(!picked.length){
    this.note('No supported AMM V4 or CPMM accounts among '+entries.length+
     ' Raydium pair candidates; other protocols require separate adapters');
    this.status='partial_error';return;
   }
   const wanted=new Set<string>();
   for(const result of picked){
    if(!this.running)return;
    const {candidate,info,slot}=result;
    wanted.add(candidate.address);
    if(this.nodes.has(candidate.address)){
     this.nodes.get(candidate.address)!.candidate=candidate;
    }else this.attach(candidate,info,slot,Date.now());
   }
   // Retain previous subscriptions when public discovery returns nothing.
   for(const id of [...this.nodes.keys()])if(!wanted.has(id))this.detach(id);
   this.lastDiscoveryAt=new Date().toISOString();
   await this.reconcile();
   this.status=this.nodes.size?'monitoring':'partial_error';
  }catch(error){this.note('C3B discovery: '+String(error));this.status='partial_error'}
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
  for(const key of [...this.nodes.keys()])this.detach(key);
  this.status='stopped';
 }
}
