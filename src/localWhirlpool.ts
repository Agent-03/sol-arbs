import {PublicKey,type AccountInfo} from '@solana/web3.js';
import BN from 'bn.js';
import {Percentage} from '@orca-so/common-sdk';
import {
 ParsableWhirlpool,ParsableTickArray,PoolUtil,SwapUtils,TickUtil,
 TokenExtensionUtil,swapQuoteWithParams,IGNORE_CACHE,
 type WhirlpoolData,type TickArray,type TokenExtensionContextForPool,
 type WhirlpoolAccountFetcherInterface
} from '@orca-so/whirlpools-sdk';
import {SOL_MINT,USDC_MINT} from './discovery.js';
import {ORCA_WHIRLPOOL} from './routes.js';
import type {MarketDataFeed,MarketObservation} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
type Direction='USDC_TO_SOL'|'SOL_TO_USDC';
type TokenCtx=TokenExtensionContextForPool;
type Layout={pool:string;directions:Record<Direction,Array<{address:string;startTickIndex:number}>>;
 release:(()=>void)[];tokenCtx:TokenCtx;};
export type LocalQuote={
 pool:string;direction:Direction;inputRaw:string;outputRaw:string;feeRaw:string;
 observedAt:string;poolSlot:number;tickArraysObservedAt:string;
 tickArraySlot:number;computedAt:string;
 quoteModel:'orca_whirlpool_sdk_in_memory';
};
export type LocalPricingHealth={
 trackedPools:number;readyPools:number;preparedPools:number;
 bootstrapReads:number;localCalculations:number;localErrors:number;
 unsupportedPools:number;lastLocalAt?:string;
 errors:string[];
};

function accountValue(a:MarketObservation):AccountInfo<Buffer>{
 return {data:Buffer.from(a.data),owner:new PublicKey(a.owner),
  lamports:a.lamports,executable:a.executable,rentEpoch:a.rentEpoch??0};
}
export function validateLocalComponents(
 observations:readonly {slot:number;receivedAt:number}[],
 now:number,maxAgeMs:number,maxSlotSkew:number
):{ok:boolean;reason?:'missing_component'|'component_age'|'slot_skew'|'future_observation';oldestAt:number;minSlot:number}{
 if(!observations.length)return {ok:false,reason:'missing_component',oldestAt:0,minSlot:0};
 const oldestAt=Math.min(...observations.map(p=>p.receivedAt));
 const slots=observations.map(p=>p.slot),minSlot=Math.min(...slots);
 if(oldestAt>now+1000)return {ok:false,reason:'future_observation',oldestAt,minSlot};
 if(now-oldestAt>maxAgeMs)return {ok:false,reason:'component_age',oldestAt,minSlot};
 if(Math.max(...slots)-minSlot>maxSlotSkew)return {ok:false,reason:'slot_skew',oldestAt,minSlot};
 return {ok:true,oldestAt,minSlot};
}
/**
 * Offline Whirlpool swap quotes using Orca's exact SDK simulation. Only the
 * initialization step touches RPC (mint metadata + one coherent pool/tick
 * account batch); the quoteExact() and account-change handlers do not.
 *
 * Fail closed if the state or *any required tick array* is missing, aged or
 * beyond slot skew. Adaptive fee / Token-2022 pools require separate support.
 * No transaction signing or broadcasting.
 */
export class LocalWhirlpoolQuoter{
 private layouts=new Map<string,Layout>();
 private pending=new Map<string,Promise<void>>();
 private errors:string[]=[];
 private bootstrapReads=0;private localCalculations=0;private localErrors=0;
 private unsupportedPools=0;
 private lastLocalAt?:string;
 private unsub?:()=>void;
 private lastErrorReason=new Map<string,string>();
 constructor(
  private readonly feed:MarketDataFeed,
  private readonly programId:PublicKey,
  private readonly fetcher:WhirlpoolAccountFetcherInterface,
  private readonly maxAgeMs:number,
  private readonly maxSlotSkew:number,
  private readonly onPoolChange:(pool:string)=>void
 ){
  this.unsub=feed.onUpdate(update=>{
   for(const pool of update.affectedPools){
    if(!this.layouts.has(pool))continue;
    try{this.onPoolChange(pool);}catch(error){this.error('Local pool callback: '+String(error));}
   }
  });
 }
 private error(reason:string){
  this.localErrors++;
  this.errors.unshift(reason);
  this.errors=this.errors.slice(0,8);
 }
 private decodePool(address:string):{observation:MarketObservation;data:WhirlpoolData}|null{
  const observation=this.feed.get(address);
  if(!observation||observation.owner!==ORCA_WHIRLPOOL)return null;
  const data=ParsableWhirlpool.parse(new PublicKey(address),accountValue(observation));
  return data?{observation,data}:null;
 }
 private tickKeys(address:string,data:WhirlpoolData,aToB:boolean){
  const pubkey=new PublicKey(address);
  const keys=SwapUtils.getTickArrayPublicKeys(
   data.tickCurrentIndex,data.tickSpacing,aToB,this.programId,pubkey);
  return keys.map((key,i)=>({
   address:key.toBase58(),
   startTickIndex:TickUtil.getStartTickIndex(
    data.tickCurrentIndex+(aToB?0:data.tickSpacing),
    data.tickSpacing,aToB?-i:i)
  }));
 }
 async prepare(pool:string):Promise<void>{
  const running=this.pending.get(pool);
  if(running)return running;
  const work=this.prepareUnsafe(pool).finally(()=>this.pending.delete(pool));
  this.pending.set(pool,work);
  return work;
 }
 private async prepareUnsafe(pool:string){
  const decoded=this.decodePool(pool);
  if(!decoded)throw new Error('Whirlpool pool account not yet available in C1 cache');
  const data=decoded.data;
  const a=data.tokenMintA.toBase58(),b=data.tokenMintB.toBase58();
  if(!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))
   throw new Error('Wrong Whirlpool mint pair');
  if(PoolUtil.isInitializedWithAdaptiveFee(data)){
   this.unsupportedPools++;
   throw new Error('Adaptive-fee Whirlpool requires cached oracle state');
  }
  const dirs:Layout['directions']={
   USDC_TO_SOL:this.tickKeys(pool,data,a===USDC_MINT),
   SOL_TO_USDC:this.tickKeys(pool,data,a===SOL_MINT)
  };
  const old=this.layouts.get(pool);
  if(old){
   const previous=JSON.stringify(old.directions),next=JSON.stringify(dirs);
   if(previous===next)return;
  }
  const ctx=await TokenExtensionUtil.buildTokenExtensionContextForPool(
   this.fetcher,data.tokenMintA,data.tokenMintB,IGNORE_CACHE);
  if(ctx.tokenMintWithProgramA.tokenProgram.toBase58()!==TOKEN_PROGRAM||
     ctx.tokenMintWithProgramB.tokenProgram.toBase58()!==TOKEN_PROGRAM){
   this.unsupportedPools++;
   throw new Error('Token-2022 Whirlpool mint unsupported in C2 local mode');
  }
  const tickKeys=[...new Set([...dirs.USDC_TO_SOL,...dirs.SOL_TO_USDC].map(x=>x.address))];
  const releases:(()=>void)[]=[];
  try{
   // Watching before the batch read avoids dropping intervening updates.
   for(const key of tickKeys)releases.push(this.feed.watch(key));
   this.feed.setDependencies(pool,[pool,...tickKeys]);
   this.bootstrapReads++;
   await this.feed.reconcile([pool,...tickKeys],'rpc_bootstrap');
   if(old)for(const release of old.release)release();
   this.layouts.set(pool,{pool,directions:dirs,release:releases,tokenCtx:ctx});
  }catch(error){
   releases.forEach(release=>release());
   if(old){
    const oldKeys=[...new Set([...old.directions.USDC_TO_SOL,...old.directions.SOL_TO_USDC].map(x=>x.address))];
    this.feed.setDependencies(pool,[pool,...oldKeys]);
   }else this.feed.setDependencies(pool,[pool]);
   throw error;
  }
 }
 quoteExact(pool:string,direction:Direction,inputRaw:bigint,now=Date.now()):LocalQuote|null{
  if(inputRaw<=0n)return null;
  const layout=this.layouts.get(pool),decoded=this.decodePool(pool);
  if(!layout||!decoded)return null;
  const aToB=direction==='USDC_TO_SOL'
   ?decoded.data.tokenMintA.toBase58()===USDC_MINT
   :decoded.data.tokenMintA.toBase58()===SOL_MINT;
  if(PoolUtil.isInitializedWithAdaptiveFee(decoded.data))return null;
  const required=this.tickKeys(pool,decoded.data,aToB);
  const known=layout.directions[direction];
  if(JSON.stringify(required)!==JSON.stringify(known)){
   this.lastErrorReason.set(pool,'tick_array_window_changed');
   return null;
  }
  const tickArrays:TickArray[]=[];
  const observations:MarketObservation[]=[decoded.observation];
  for(const {address,startTickIndex} of required){
   const observation=this.feed.get(address);
   // Missing tick arrays must not be guessed to be empty. C2 fails
   // closed until a coherent snapshot actually verifies their state.
   if(!observation){
    this.lastErrorReason.set(pool,'tick_array_not_cached');
    return null;
   }
   if(observation.owner!==ORCA_WHIRLPOOL){
    this.lastErrorReason.set(pool,'tick_array_owner_mismatch');return null;
   }
   const parsed=ParsableTickArray.parse(new PublicKey(address),accountValue(observation));
   if(!parsed||parsed.whirlpool.toBase58()!==pool||parsed.startTickIndex!==startTickIndex){
    this.lastErrorReason.set(pool,'tick_array_decode_or_membership_failed');return null;
   }
   observations.push(observation);
   tickArrays.push({address:new PublicKey(address),startTickIndex,data:parsed});
  }
  const valid=validateLocalComponents(observations,now,this.maxAgeMs,this.maxSlotSkew);
  if(!valid.ok){this.lastErrorReason.set(pool,valid.reason??'invalid');return null;}
  try{
   const result=swapQuoteWithParams({
    whirlpoolData:decoded.data,tokenAmount:new BN(inputRaw.toString()),
    otherAmountThreshold:SwapUtils.getDefaultOtherAmountThreshold(true),
    sqrtPriceLimit:SwapUtils.getDefaultSqrtPriceLimit(aToB),
    aToB,amountSpecifiedIsInput:true,tickArrays,oracleData:null,
    tokenExtensionCtx:layout.tokenCtx,timestampInSeconds:new BN(Math.floor(now/1000))
   },Percentage.fromFraction(0,10000));
   if(result.estimatedAmountOut.lten(0))return null;
   this.localCalculations++;this.lastLocalAt=new Date(now).toISOString();
   this.lastErrorReason.delete(pool);
   const tickAt=Math.min(...observations.slice(1).map(x=>x.receivedAt));
   return {pool,direction,inputRaw:inputRaw.toString(),
    outputRaw:result.estimatedAmountOut.toString(),feeRaw:result.estimatedFeeAmount.toString(),
    observedAt:new Date(valid.oldestAt).toISOString(),poolSlot:decoded.observation.slot,
    tickArraysObservedAt:new Date(tickAt).toISOString(),tickArraySlot:valid.minSlot,
    computedAt:new Date(now).toISOString(),quoteModel:'orca_whirlpool_sdk_in_memory'};
  }catch(error){this.lastErrorReason.set(pool,String(error));this.error('Local Whirlpool '+pool+': '+String(error));return null;}
 }
 snapshot():LocalPricingHealth{
  let readyPools=0;
  for(const pool of this.layouts.keys()){
   if(this.quoteExact(pool,'USDC_TO_SOL',5000000n))readyPools++;
  }
  return {trackedPools:this.layouts.size,preparedPools:this.layouts.size,readyPools,
   bootstrapReads:this.bootstrapReads,localCalculations:this.localCalculations,
   localErrors:this.localErrors,unsupportedPools:this.unsupportedPools,
   lastLocalAt:this.lastLocalAt,errors:[...this.errors]};
 }
 forget(pool:string){
  const layout=this.layouts.get(pool);
  if(!layout)return;
  layout.release.forEach(release=>release());
  this.layouts.delete(pool);
  this.lastErrorReason.delete(pool);
  this.feed.setDependencies(pool,[pool]);
 }
 stop(){
  this.unsub?.();this.unsub=undefined;
  for(const pool of [...this.layouts.keys()])this.forget(pool);
 }
}
