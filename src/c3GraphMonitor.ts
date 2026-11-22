import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {decodeAmmV4AnyPair,decodeVault} from './ammV4.js';
import {RAYDIUM_AMM_V4} from './routes.js';
import {GRAPH_ASSETS,assetOfMint,evaluateGraphCycles,
 type GraphAsset,type GraphPool,type GraphEvaluation,type GraphScanLimits} from './c3Graph.js';
import type {MarketDataFeed} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AMM_AUTHORITY=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
type Candidate={address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number};
type Component={owner:string;data:Buffer;slot:number;at:number};
type PoolWatch={candidate:Candidate;keys:[string,string,string];components:Map<string,Component>;release:(()=>void)[]};
export type GraphMonitorOptions={
 enabled:boolean;maxPools:number;perPair:number;refreshMs:number;reconcileMs:number;
 sizesUsd:number[];maxPathChecks:number;maxResults:number;maxQuoteAgeMs:number;
 maxQuoteGapMs:number;maxSlotSkew:number;minLiquidityUsd:number;assumedCostUsd:number;
};
export type GraphMonitorSnapshot=GraphEvaluation&{
 status:'disabled'|'discovering'|'warming'|'monitoring'|'partial_error'|'stopped';
 trackedPools:number;watchedAccounts:number;rpcReconciles:number;
 wsUpdates:number;localEvaluations:number;lastDiscoveryAt?:string;
 lastReconcileAt?:string;errors:string[];
};
const baseline=(options:GraphMonitorOptions):GraphEvaluation=>
 evaluateGraphCycles([],{sizesUsd:options.sizesUsd,maxAgeMs:options.maxQuoteAgeMs,
  maxGapMs:options.maxQuoteGapMs,maxSlotSkew:options.maxSlotSkew,
  minLiquidityUsd:options.minLiquidityUsd,maxPathChecks:options.maxPathChecks,
  maxResults:options.maxResults,assumedCostUsd:options.assumedCostUsd});

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
  sortType:'desc',pageSize:'25',page:'1'}))u.searchParams.set(key,val);
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
  const infos=node.keys.map(key=>node.components.get(key));
  if(infos.some(x=>!x))return null;
  const components=infos as Component[];
  if(components[0].owner!==RAYDIUM_AMM_V4||
   components[1].owner!==TOKEN_PROGRAM||components[2].owner!==TOKEN_PROGRAM)return null;
  try{
   const state=decodeAmmV4AnyPair(pool,components[0].data);
   if(state.baseVault!==vaultA||state.quoteVault!==vaultB)return null;
   const a=assetOfMint(state.baseMint),b=assetOfMint(state.quoteMint);
   if(!a||!b||a===b||a!==node.candidate.tokenA||b!==node.candidate.tokenB)return null;
   const balA=decodeVault(components[1].data,state.baseMint,AMM_AUTHORITY)-state.baseNeedTakePnl;
   const balB=decodeVault(components[2].data,state.quoteMint,AMM_AUTHORITY)-state.quoteNeedTakePnl;
   if(balA<=0n||balB<=0n)return null;
   const slotGap=Math.max(...components.map(x=>x.slot))-Math.min(...components.map(x=>x.slot));
   const oldest=Math.min(...components.map(x=>x.at));
   if(slotGap>this.options.maxSlotSkew||now-oldest>this.options.maxQuoteAgeMs)return null;
   return {address:pool,program:'raydium_amm_v4',tokenA:a,tokenB:b,
    reserveA:balA.toString(),reserveB:balB.toString(),
    feeNumerator:state.feeNumerator.toString(),feeDenominator:state.feeDenominator.toString(),
    observedAt:new Date(oldest).toISOString(),poolSlot:components[0].slot,
    vaultSlot:Math.min(components[1].slot,components[2].slot),
    liquidityUsd:node.candidate.liquidityUsd,
    snapshotIntegrity:'bounded_slot_research'};
  }catch{return null}
 }
 private evaluate(){
  const at=Date.now();
  const pools=[...this.nodes.values()].map(p=>this.extract(p,at)).filter((p):p is GraphPool=>p!==null);
  this.evaluation=evaluateGraphCycles(pools,{
   sizesUsd:this.options.sizesUsd,maxAgeMs:this.options.maxQuoteAgeMs,
   maxGapMs:this.options.maxQuoteGapMs,maxSlotSkew:this.options.maxSlotSkew,
   minLiquidityUsd:this.options.minLiquidityUsd,maxPathChecks:this.options.maxPathChecks,
   maxResults:this.options.maxResults,assumedCostUsd:this.options.assumedCostUsd
  },at);
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
  const state=decodeAmmV4AnyPair(candidate.address,info.data);
  if(assetOfMint(state.baseMint)!==candidate.tokenA||
   assetOfMint(state.quoteMint)!==candidate.tokenB)return;
  const keys:[string,string,string]=[candidate.address,state.baseVault,state.quoteVault];
  const release:(()=>void)[]=[];
  try{
   keys.forEach((key,i)=>{
    this.feed.expectOwner(key,i===0?RAYDIUM_AMM_V4:TOKEN_PROGRAM);
    release.push(this.feed.watch(key));
   });
   const entry:PoolWatch={candidate,keys,release,components:new Map()};
   this.nodes.set(candidate.address,entry);
   keys.forEach(key=>{
    const set=this.byAccount.get(key)??new Set<string>();
    set.add(candidate.address);this.byAccount.set(key,set);
   });
   entry.components.set(candidate.address,{owner:RAYDIUM_AMM_V4,
    data:Buffer.from(info.data),slot,at:now});
   // Existing C1 subscribers may already have newer bytes.
   for(const key of keys){
    const previous=this.feed.get(key);
    if(previous&&previous.slot>=slot)
     entry.components.set(key,{owner:previous.owner,data:Buffer.from(previous.data),
      slot:previous.slot,at:previous.receivedAt});
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
     buckets.push(result.value.filter(x=>x.liquidityUsd>=this.options.minLiquidityUsd)
      .slice(0,this.options.perPair));
    }else{
     buckets.push([]);
     this.note('Raydium '+pairs[i].join('/')+' discovery: '+String(result.reason));
    }
   });
   const picked:Candidate[]=[];const seen=new Set<string>();
   for(let tier=0;tier<this.options.perPair;tier++)for(const bucket of buckets){
    if(picked.length>=this.options.maxPools)break;
    const candidate=bucket[tier];
    if(candidate&&!seen.has(candidate.address)){
     seen.add(candidate.address);picked.push(candidate);
    }
   }
   if(!picked.length){
    this.note('No AMM V4 token-pair candidates in public discovery response');
    this.status='partial_error';return;
   }
   const wanted=new Set<string>();
   for(let start=0;start<picked.length;start+=75){
    const block=picked.slice(start,start+75);
    const response=await this.rpc.getMultipleAccountsInfoAndContext(
     block.map(p=>new PublicKey(p.address)),'confirmed');
    if(!this.running)return;
    response.value.forEach((info,i)=>{
     if(!info||info.owner.toBase58()!==RAYDIUM_AMM_V4)return;
     const candidate=block[i];
     try{
      const decoded=decodeAmmV4AnyPair(candidate.address,info.data);
      if(assetOfMint(decoded.baseMint)!==candidate.tokenA||
       assetOfMint(decoded.quoteMint)!==candidate.tokenB)return;
      wanted.add(candidate.address);
      if(this.nodes.has(candidate.address)){
       this.nodes.get(candidate.address)!.candidate=candidate;
      }else this.attach(candidate,info,response.context.slot,Date.now());
     }catch{/* reject other Raydium pool programs */}
    });
   }
   // Retain previous subscriptions if discovery failed entirely.
   if(wanted.size){
    for(const id of [...this.nodes.keys()])if(!wanted.has(id))this.detach(id);
   }
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
