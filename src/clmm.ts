import {Connection,PublicKey,type EpochInfo} from '@solana/web3.js';
import {Raydium,PoolUtils,PoolInfoLayout,TickArrayLayout,TickArrayBitmapExtensionLayout,ClmmConfigLayout,TickUtil} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import {SOL_MINT,USDC_MINT,type DiscoveredPool} from './discovery.js';
import {RAYDIUM_CLMM} from './routes.js';
import type {MarketDataFeed} from './marketData.js';
import {validateLocalComponents} from './localWhirlpool.js';

type ClmmSdkData=Awaited<ReturnType<InstanceType<typeof Raydium>['clmm']['getPoolInfoFromRpc']>>;
type Cached={
 observedAt:string;finishedAt:string;slot:number;
 data:ClmmSdkData;epochInfo:EpochInfo;
 tickArrayCount:number;
 tickKeys:string[];extraKeys:[string,string];release:(()=>void)[];
 tickArraySlot:number|null;verifiedCache:boolean;
};
export type ClmmQuote={
 pool:string;direction:'USDC_TO_SOL'|'SOL_TO_USDC'|'GENERIC_INPUT';
 inputRaw:string;outputRaw:string;observedAt:string;computedAt:string;poolSlot:number;
 feeRaw:string;tickArraysObservedAt:string;tickArraySlot:number|null;
 quoteModel:'raydium_clmm_sdk_tick_array';
 snapshotIntegrity:'multi_rpc_context_unverified'|'bounded_slot_cached';
};
export type ClmmHealth={
 status:'idle'|'scanning'|'ok'|'partial_error';
 selectedPools:number;readyPools:number;quotes:ClmmQuote[];
 errors:string[];perPool:Array<{pool:string;status:'fresh'|'expired'|'missing'|'refreshing';reason?:string;
   lastObservedAt?:string;ageMs?:number;tickArrays:number;slot?:number;
   tickArraySlot?:number|null;tickArraySlotVerified?:boolean}>;
 scans:number;lastUpdatedAt?:string;
 poolAccountEvents?:number;selectiveScans?:number;pendingDirtyPools?:number;
 localEvents?:number;localRecomputations?:number;activeTickSubscriptions?:number;
 slotVerifiedPools?:number;
};

export function isClmmPair(a:string,b:string):boolean{
 return (a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT);
}
export function validateClmmQuoteOutput(inputRaw:bigint,outputRaw:string):bigint{
 if(inputRaw<=0n||!/^[0-9]+$/.test(outputRaw))throw new Error('Malformed Raydium CLMM SDK quote');
 const out=BigInt(outputRaw);
 if(out<=0n)throw new Error('Zero or negative Raydium CLMM SDK output');
 return out;
}
/**
 * SDK tick-array-aware CLMM quotes, NOT a spot-price approximation.
 * SDK getPoolInfoFromRpc pulls pool, tick arrays, bitmap/config, and mint
 * information over separate RPC calls. Since their slots are NOT coherent,
 * all quotes are indicative and cannot establish executable profitability.
 */
export class ClmmMonitor {
 private sdk?:Raydium;
 private cache=new Map<string,Cached>();
 private busy=false;
 private running=false;
 private timer?:ReturnType<typeof setTimeout>;
 private lastUpdatedAt?:string;
 private errors:string[]=[];
 private scans=0;
 private refreshing?:string;
 private failures=new Map<string,string>();
 private readinessReasons=new Map<string,string>();
 private pendingDirty=new Set<string>();
 private requestTimer?:ReturnType<typeof setTimeout>;
 private dirtyEvents=0;
 private selectiveScans=0;
 private lastSelectiveAt=0;
 private feedListener?:()=>void;
 private localEvents=0;private localRecomputations=0;

 constructor(
  private readonly connection:Connection,
  private readonly pools:DiscoveredPool[],
  private readonly sizesUsd:number[],
  private readonly minLiquidityUsd:number,
  private readonly maxPools:number,
  private readonly scanIntervalMs:number,
  private readonly maxCacheAgeMs:number,
  private readonly onUpdate:()=>void,
  private readonly feed?:MarketDataFeed,
  private readonly maxSlotSkew=12,
  private readonly permittedMints?:ReadonlySet<string>,
  private readonly dependencyPrefix=''
 ){
  if(this.feed)this.feedListener=this.feed.onUpdate(update=>{
   for(const dependency of update.affectedPools){
    if(this.dependencyPrefix&&!dependency.startsWith(this.dependencyPrefix))continue;
    const poolId=this.dependencyPrefix?dependency.slice(this.dependencyPrefix.length):dependency;
    if(!this.cache.has(poolId))continue;
    this.localEvents++;
    if(this.applyFeedState(poolId))this.onUpdate();
   }
  });
 }
 private chosen():DiscoveredPool[]{
  return this.pools.filter(p=>p.owner===RAYDIUM_CLMM&&
   (p.venue==='raydium'||p.venue==='manual')&&
   (p.liquidityUsd===undefined||p.liquidityUsd>=this.minLiquidityUsd))
   .sort((a,b)=>(b.liquidityUsd??0)-(a.liquidityUsd??0))
   .slice(0,this.maxPools);
 }
 private async init():Promise<Raydium>{
  if(!this.sdk)this.sdk=await Raydium.load({connection:this.connection,disableLoadToken:true,disableFeatureCheck:true});
  return this.sdk;
 }
 private selected(cache:Cached,now=Date.now()):boolean{
  return now-Date.parse(cache.observedAt)<=this.maxCacheAgeMs;
 }
 private releaseCache(pool:string){
  const previous=this.cache.get(pool);
  if(!previous)return;
  previous.release.forEach(stop=>stop());
  this.cache.delete(pool);
  this.readinessReasons.delete(pool);
  if(this.feed?.hasDependencies(this.dependencyPrefix+pool))this.feed.clearDependencies(this.dependencyPrefix+pool);
 }
 /** Update cached CLMM swap parameters from the same slot-aware pool/tick
  * account stream. No SDK/RPC request occurs in this callback.
  */
 private applyFeedState(pool:string):boolean{
  const entry=this.cache.get(pool);
  if(!entry||!this.feed)return false;
  const poolState=this.feed.get(pool);
  const tickStates=entry.tickKeys.map(key=>this.feed!.get(key));
  const configState=this.feed.get(entry.extraKeys[0]);
  const extension=this.feed.get(entry.extraKeys[1]);
  const verifiedNoExtension=this.feed.getVerifiedAbsent(entry.extraKeys[1]);
  if(!poolState||tickStates.some(t=>!t)||!configState||!extension&&!verifiedNoExtension){
   const reasons:string[]=[];
   if(!poolState)reasons.push('pool_state_missing');
   const tickMissing=tickStates.filter(t=>!t).length;
   if(tickMissing)reasons.push('tick_arrays_missing_'+tickMissing);
   if(!configState)reasons.push('config_account_missing');
   if(!extension&&!verifiedNoExtension)reasons.push('bitmap_extension_unverified');
   this.readinessReasons.set(pool,reasons.join(','));
   entry.verifiedCache=false;
   return false;
  }
  const observations=[poolState,configState,
   ...tickStates.filter((t):t is NonNullable<typeof t>=>Boolean(t)),
   ...(extension?[extension]:[verifiedNoExtension!])];
  const valid=validateLocalComponents(observations,Date.now(),this.maxCacheAgeMs,this.maxSlotSkew);
  if(!valid.ok){
   this.readinessReasons.set(pool,valid.reason??'invalid_component_freshness');
   entry.verifiedCache=false;return false;
  }
  try{
   if(poolState.owner!==RAYDIUM_CLMM)throw new Error('CLMM owner changed');
   const decoded=PoolInfoLayout.decode(poolState.data);
   if(configState.owner!==RAYDIUM_CLMM||extension&&extension.owner!==RAYDIUM_CLMM)
    throw new Error('CLMM config/bitmap owner mismatch');
   const config=ClmmConfigLayout.decode(configState.data);
   if(!decoded.configId.equals(new PublicKey(entry.extraKeys[0]))||config.tickSpacing!==decoded.tickSpacing)
    throw new Error('CLMM config relation or tick spacing changed');
   const exBitmapInfo=extension?TickArrayBitmapExtensionLayout.decode(extension.data):
    entry.data.computePoolInfo.exBitmapInfo;
   if(extension&&!exBitmapInfo.poolId.equals(new PublicKey(pool)))
    throw new Error('CLMM bitmap points to wrong pool');
   if(!decoded.mintA.equals(new PublicKey(entry.data.poolInfo.mintA.address))||
      !decoded.mintB.equals(new PublicKey(entry.data.poolInfo.mintB.address)))
    throw new Error('CLMM mint pair changed');
   const ticks:NonNullable<ClmmSdkData['tickData'][string]>={};
   for(let i=0;i<entry.tickKeys.length;i++){
    const addr=entry.tickKeys[i],state=tickStates[i]!;
    if(state.owner!==RAYDIUM_CLMM)throw new Error('CLMM tick owner changed');
    const tick=TickArrayLayout.decode(state.data);
    if(!tick.poolId.equals(new PublicKey(pool)))throw new Error('CLMM tick array points at wrong pool');
    const expected=entry.data.tickArrays.find(row=>row.address.toBase58()===addr);
    if(!expected||tick.startTickIndex!==expected.startTickIndex)throw new Error('Unexpected CLMM tick index');
    ticks[tick.startTickIndex]={...tick,address:new PublicKey(addr)};
   }
   entry.data.computePoolInfo={
    ...entry.data.computePoolInfo,
    accInfo:decoded,liquidity:decoded.liquidity,sqrtPriceX64:decoded.sqrtPriceX64,
    currentPrice:TickUtil.sqrtPriceX64ToPrice(decoded.sqrtPriceX64,
     entry.data.poolInfo.mintA.decimals,entry.data.poolInfo.mintB.decimals),
    tickCurrent:decoded.tickCurrent,tickArrayBitmap:decoded.tickArrayBitmap,
    ammConfig:{...entry.data.computePoolInfo.ammConfig,
     index:config.index,tradeFeeRate:config.tradeFeeRate,
     protocolFeeRate:config.protocolFeeRate,fundFeeRate:config.fundFeeRate,
     tickSpacing:config.tickSpacing},
    exBitmapInfo
   };
   entry.data.tickData[pool]=ticks;
   entry.slot=valid.minSlot;
   entry.tickArraySlot=Math.min(...tickStates.map(t=>t!.slot));
   entry.observedAt=new Date(valid.oldestAt).toISOString();
   entry.verifiedCache=true;
   this.readinessReasons.delete(pool);
   this.localRecomputations++;
   return true;
  }catch(error){
   entry.verifiedCache=false;
   this.readinessReasons.set(pool,'onchain_state_decode: '+String(error));
   this.errors.unshift(pool+': local CLMM decoding: '+String(error));
   this.errors=this.errors.slice(0,10);
   return false;
  }
 }
 private async attachFeed(pool:string,entry:Cached):Promise<void>{
  if(!this.feed)return;
  const keys=[...new Set(entry.data.tickArrays.map(x=>x.address.toBase58()))];
  if(!keys.length)throw new Error('SDK did not expose CLMM tick-array addresses');
  const extraKeys:[string,string]=[
   entry.data.rpcPoolInfo.configId.toBase58(),
   entry.data.computePoolInfo.exBitmapAccount.toBase58()
  ];
  const allKeys=[...new Set([pool,...keys,...extraKeys])];
  const releases:(()=>void)[]=[];
  try{
   for(const address of allKeys){
    this.feed.expectOwner(address,RAYDIUM_CLMM);
    releases.push(this.feed.watch(address));
   }
   this.feed.setDependencies(this.dependencyPrefix+pool,[pool,...allKeys]);
   await this.feed.reconcile([pool,...allKeys],'rpc_bootstrap');
   entry.tickKeys=keys;entry.extraKeys=extraKeys;
   entry.release=releases;
   this.cache.set(pool,entry);
   this.applyFeedState(pool);
  }catch(error){
   releases.forEach(stop=>stop());
   this.feed.clearDependencies(this.dependencyPrefix+pool);
   throw error;
  }
 }

 quoteExact(pool:string,direction:'USDC_TO_SOL'|'SOL_TO_USDC',inputRaw:bigint):ClmmQuote|null{
  return this.quoteByInputMint(pool,direction==='USDC_TO_SOL'?USDC_MINT:SOL_MINT,inputRaw,direction);
 }
 quoteByInputMint(pool:string,mint:string,inputRaw:bigint,
  direction:ClmmQuote['direction']='GENERIC_INPUT'):ClmmQuote|null{
  const cache=this.cache.get(pool);
  if(!cache||!this.selected(cache)||this.feed&&!cache.verifiedCache)return null;
  const {data,epochInfo}=cache;
  if(this.permittedMints
    ?(!this.permittedMints.has(data.poolInfo.mintA.address)||
      !this.permittedMints.has(data.poolInfo.mintB.address)||
      data.poolInfo.mintA.address===data.poolInfo.mintB.address)
    :!isClmmPair(data.poolInfo.mintA.address,data.poolInfo.mintB.address))return null;
  if(mint!==data.poolInfo.mintA.address&&mint!==data.poolInfo.mintB.address)return null;
  if(data.poolInfo.programId!==RAYDIUM_CLMM)return null;
  const ticks=data.tickData[pool];
  if(!ticks||!Object.keys(ticks).length)return null;
  try{
   const amountIn=new BN(inputRaw.toString());
   const estimate=PoolUtils.computeAmountOut({
    poolInfo:data.computePoolInfo,
    tickarrayBitmapExtension:data.computePoolInfo.exBitmapInfo,
    tickArrayCache:ticks,
    baseMint:new PublicKey(mint),
    amountIn,
    epochInfo,
    slippage:0,
    catchLiquidityInsufficient:false,
    blockTimestamp:Math.floor(Date.now()/1000)
   });
   if(!estimate.allTrade)return null;
   const outputRaw=estimate.amountOut.amount.toString();
   validateClmmQuoteOutput(inputRaw,outputRaw);
   return {
    pool,direction,inputRaw:inputRaw.toString(),outputRaw,
    observedAt:cache.observedAt,computedAt:new Date().toISOString(),
    poolSlot:cache.slot,feeRaw:estimate.fee.toString(),
    tickArraysObservedAt:cache.observedAt,tickArraySlot:cache.tickArraySlot,
    quoteModel:'raydium_clmm_sdk_tick_array',
    snapshotIntegrity:cache.verifiedCache?'bounded_slot_cached':'multi_rpc_context_unverified'
   };
  }catch{return null;}
 }
 graphSnapshot(pool:string,now=Date.now()){
  const cache=this.cache.get(pool);
  if(!cache||!this.selected(cache,now)||!cache.verifiedCache||cache.tickArraySlot===null)return null;
  return {mintA:cache.data.poolInfo.mintA.address,mintB:cache.data.poolInfo.mintB.address,
   observedAt:cache.observedAt,poolSlot:cache.slot,tickSlot:cache.tickArraySlot};
 }
 replacePools(pools:DiscoveredPool[]){this.pools.splice(0,this.pools.length,...pools);}
 getBuys():ClmmQuote[]{
  const quotes:ClmmQuote[]=[];
  for(const pool of this.chosen())for(const size of this.sizesUsd){
   const q=this.quoteExact(pool.address,'USDC_TO_SOL',BigInt(Math.round(size*1e6)));
   if(q)quotes.push(q);
  }
  return quotes;
 }
 async scanOnce(onlyPools?:ReadonlySet<string>){
  if(this.busy)return;
  this.busy=true;this.running=true;
  try{
   const sdk=await this.init();
   const epochInfo=await sdk.fetchEpochInfo();
   const allSelected=this.chosen();
   const selected=onlyPools?allSelected.filter(pool=>onlyPools.has(pool.address)):allSelected;
   const valid=new Set(allSelected.map(p=>p.address));
   for(const pool of this.cache.keys())if(!valid.has(pool))this.releaseCache(pool);
   for(const pool of selected){
    this.refreshing=pool.address;
    const started=new Date().toISOString();
    try{
     const checked=await this.connection.getAccountInfoAndContext(new PublicKey(pool.address),'confirmed');
     if(!checked.value||checked.value.owner.toBase58()!==RAYDIUM_CLMM)
      throw new Error('CLMM program owner verification failed');
     // The Raydium SDK traverses real liquidity ranges and tick arrays.
     const data=await sdk.clmm.getPoolInfoFromRpc(pool.address);
     if(data.poolInfo.programId!==RAYDIUM_CLMM||
       (this.permittedMints
        ?(!this.permittedMints.has(data.poolInfo.mintA.address)||
          !this.permittedMints.has(data.poolInfo.mintB.address)||
          data.poolInfo.mintA.address===data.poolInfo.mintB.address)
        :!isClmmPair(data.poolInfo.mintA.address,data.poolInfo.mintB.address)))
      throw new Error('CLMM mint/program mismatch');
     const ticks=data.tickData[pool.address];
     if(!ticks||!Object.keys(ticks).length)throw new Error('missing or uninitialized tick arrays');
     const entry:Cached={observedAt:started,finishedAt:new Date().toISOString(),
      slot:checked.context.slot,data,epochInfo,tickArrayCount:Object.keys(ticks).length,
      tickKeys:[],extraKeys:['',''],release:[],tickArraySlot:null,verifiedCache:!this.feed};
     const previous=this.cache.get(pool.address);
     if(this.feed){
      // New watches are installed before prior ones are released.
      // A rejected snapshot is not silently called coherent.
      await this.attachFeed(pool.address,entry);
     }else this.cache.set(pool.address,entry);
     if(previous&&previous!==entry)previous.release.forEach(stop=>stop());
     this.failures.delete(pool.address);
     this.onUpdate();
    }catch(e){
     this.failures.set(pool.address,String(e));
     this.errors.unshift(pool.address+': '+String(e));
     this.errors=this.errors.slice(0,10);
    }
   }
   this.scans++;this.lastUpdatedAt=new Date().toISOString();
  }catch(e){
   this.errors.unshift('CLMM SDK initialization or scan failed: '+String(e));
   this.errors=this.errors.slice(0,10);
  }finally{this.refreshing=undefined;this.busy=false;}
 }
 requestPoolRefresh(address:string){
  if(!this.running||!this.chosen().some(pool=>pool.address===address))return;
  this.dirtyEvents++;
  this.pendingDirty.add(address);
  this.scheduleDirtyRefresh();
 }
 private scheduleDirtyRefresh(){
  if(!this.running||this.requestTimer||!this.pendingDirty.size)return;
  // These are still SDK/RPC tick-array reads, so coalesce bursts to
  // avoid overloading the shared provider. C2 removes these hot-path reads.
  const delay=Math.max(300,15000-(Date.now()-this.lastSelectiveAt));
  this.requestTimer=setTimeout(()=>{
   this.requestTimer=undefined;
   if(!this.running)return;
   if(this.busy){this.scheduleDirtyRefresh();return;}
   const selected=new Set(this.pendingDirty);
   this.pendingDirty.clear();
   this.lastSelectiveAt=Date.now();
   this.selectiveScans++;
   void this.scanOnce(selected).finally(()=>this.scheduleDirtyRefresh());
  },delay);
 }
 start(){
  if(this.running)return;
  this.running=true;
  const loop=async()=>{
   if(!this.running)return;
   await this.scanOnce();
   if(this.running)this.timer=setTimeout(()=>{void loop();},this.scanIntervalMs);
  };
  void loop();
 }
 stop(){this.running=false;if(this.timer)clearTimeout(this.timer);
  if(this.requestTimer)clearTimeout(this.requestTimer);this.pendingDirty.clear();
  this.feedListener?.();this.feedListener=undefined;
  for(const pool of [...this.cache.keys()])this.releaseCache(pool);
 }
 snapshot():ClmmHealth{
  const now=Date.now();
  const selected=this.chosen();
  const perPool=selected.map(p=>{
   const cache=this.cache.get(p.address);
   const ageMs=cache?now-Date.parse(cache.observedAt):undefined;
   const status:'fresh'|'expired'|'missing'|'refreshing'=this.refreshing===p.address?'refreshing':
    !cache?'missing':!cache.verifiedCache?'expired':this.selected(cache,now)?'fresh':'expired';
   return {pool:p.address,status,
    reason:this.failures.get(p.address)??this.readinessReasons.get(p.address)??
     (cache&&!cache.verifiedCache?'tick_array_state_incomplete_or_slot_skew':undefined),
    lastObservedAt:cache?.observedAt,ageMs,tickArrays:cache?.tickArrayCount??0,
    slot:cache?.slot,tickArraySlot:cache?.tickArraySlot??null,
    tickArraySlotVerified:cache?.verifiedCache??false};
  });
  const quotes=this.getBuys();
  return {status:this.busy?'scanning':this.failures.size?'partial_error':'ok',
   selectedPools:selected.length,readyPools:perPool.filter(p=>p.status==='fresh').length,
   quotes,errors:[...this.errors],perPool,scans:this.scans,lastUpdatedAt:this.lastUpdatedAt,
   poolAccountEvents:this.dirtyEvents,selectiveScans:this.selectiveScans,pendingDirtyPools:this.pendingDirty.size,
   localEvents:this.localEvents,localRecomputations:this.localRecomputations,
   activeTickSubscriptions:[...this.cache.values()].reduce((sum,x)=>sum+x.release.length,0),
   slotVerifiedPools:[...this.cache.values()].filter(x=>x.verifiedCache).length};
 }
}
