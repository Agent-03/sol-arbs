import {PublicKey,type AccountInfo} from '@solana/web3.js';
import BN from 'bn.js';
import {Percentage} from '@orca-so/common-sdk';
import {
 ParsableWhirlpool,ParsableTickArray,ParsableOracle,PoolUtil,SwapUtils,TickUtil,PDAUtil,
 TokenExtensionUtil,swapQuoteWithParams,IGNORE_CACHE,
 type WhirlpoolData,type TickArray,type OracleData,type TokenExtensionContextForPool,
 type WhirlpoolAccountFetcherInterface
} from '@orca-so/whirlpools-sdk';
import {SOL_MINT,USDC_MINT} from './discovery.js';
import {ORCA_WHIRLPOOL} from './routes.js';
import type {MarketDataFeed,MarketObservation} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
type Direction='USDC_TO_SOL'|'SOL_TO_USDC'|'A_TO_B'|'B_TO_A';
type TokenCtx=TokenExtensionContextForPool;
type Layout={pool:string;directions:Record<Direction,Array<{address:string;startTickIndex:number}>>;
 release:(()=>void)[];tokenCtx:TokenCtx;oracleAddress:string|null;};
export type LocalQuote={
 pool:string;direction:Direction;inputRaw:string;outputRaw:string;feeRaw:string;
 observedAt:string;poolSlot:number;tickArraysObservedAt:string;
 tickArraySlot:number;computedAt:string;
 quoteModel:'orca_whirlpool_sdk_in_memory';
};
export type LocalQuoteFailure={
 pool:string;direction:Direction;inputRaw:string;reason:string;firstAt:string;lastAt:string;
 skipCount:number;componentKey:string;
};
/** Pure failure gate: cache a rejected exact-input quote only for the
 * component state which produced the failure. A new pool or tick-array
 * hash/slot automatically re-enables computation.
 */
export class QuoteFailureGate{
 private rows=new Map<string,LocalQuoteFailure>();
 private skipped=0;
 constructor(private readonly maxEntries=512){
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1)throw new Error('Invalid quote failure cache capacity');
 }
 private key(pool:string,direction:Direction,inputRaw:bigint){return pool+':'+direction+':'+inputRaw;}
 blocked(pool:string,direction:Direction,inputRaw:bigint,componentKey:string){
  const id=this.key(pool,direction,inputRaw),f=this.rows.get(id);
  if(!f||f.componentKey!==componentKey)return false;
  f.skipCount++;f.lastAt=new Date().toISOString();this.skipped++;return true;
 }
 reject(pool:string,direction:Direction,inputRaw:bigint,componentKey:string,reason:string){
  const id=this.key(pool,direction,inputRaw),now=new Date().toISOString();
  const prior=this.rows.get(id);
  if(prior?.componentKey===componentKey)return false;
  // Full quote mode may probe many distinct SOL amounts. Keep bounded
  // state instead of growing without limit across independent snapshots.
  this.rows.delete(id);
  this.rows.set(id,{pool,direction,inputRaw:inputRaw.toString(),componentKey,reason,
   firstAt:now,lastAt:now,skipCount:0});
  while(this.rows.size>this.maxEntries){
   const oldest=this.rows.keys().next().value;
   if(oldest===undefined)break;
   this.rows.delete(oldest);
  }
  return true;
 }
 recover(pool:string,direction:Direction,inputRaw:bigint){
  this.rows.delete(this.key(pool,direction,inputRaw));
 }
 clearPool(pool:string){
  for(const [key,row] of this.rows)if(row.pool===pool)this.rows.delete(key);
 }
 get(pool:string,direction:Direction,inputRaw:bigint){return this.rows.get(this.key(pool,direction,inputRaw));}
 summary(){return {activeFailures:this.rows.size,skippedRecalculations:this.skipped,
  failures:[...this.rows.values()].map(f=>({...f,componentKey:undefined}))};}
}
export type LocalPricingHealth={
 trackedPools:number;readyPools:number;preparedPools:number;
 bootstrapReads:number;localCalculations:number;localErrors:number;
 unsupportedPools:number;lastLocalAt?:string;
 validatedAgainstSdk:number;validationMismatches:number;
 verifiedUninitializedTickArrays:number;
 activeUnquotableSizes:number;skippedUnquotableRecomputations:number;
 unquotableQuotes:Array<Omit<LocalQuoteFailure,'componentKey'>>;
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
 * Fail closed if the state, required tick arrays or adaptive-fee oracle is
 * missing, aged, or beyond slot skew. Token-2022 pools remain excluded.
 * No transaction signing or broadcasting.
 */
export class LocalWhirlpoolQuoter{
 private layouts=new Map<string,Layout>();
 private pending=new Map<string,Promise<void>>();
 private errors:string[]=[];
 private bootstrapReads=0;private localCalculations=0;private localErrors=0;
 private unsupportedPools=0;
 private lastLocalAt?:string;
 private validatedAgainstSdk=0;private validationMismatches=0;
 private verifiedUninitializedTickArrays=0;
 private unsub?:()=>void;
 private lastErrorReason=new Map<string,string>();
 private readonly failureGate=new QuoteFailureGate();
 constructor(
  private readonly feed:MarketDataFeed,
  private readonly programId:PublicKey,
  private readonly fetcher:WhirlpoolAccountFetcherInterface,
  private readonly maxAgeMs:number,
  private readonly maxSlotSkew:number,
  private readonly onPoolChange:(pool:string)=>void,
  private readonly permittedMints?:ReadonlySet<string>,
  private readonly dependencyPrefix=''
 ){
  this.unsub=feed.onUpdate(update=>{
   for(const dependency of update.affectedPools){
    if(this.dependencyPrefix&&!dependency.startsWith(this.dependencyPrefix))continue;
    const pool=this.dependencyPrefix?dependency.slice(this.dependencyPrefix.length):dependency;
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
  if(this.permittedMints
    ? (!this.permittedMints.has(a)||!this.permittedMints.has(b)||a===b)
    : !((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))
   throw new Error('Unsupported Whirlpool mint pair');
  const oracleAddress=PoolUtil.isInitializedWithAdaptiveFee(data)
   ?PDAUtil.getOracle(this.programId,new PublicKey(pool)).publicKey.toBase58():null;
  const dirs:Layout['directions']={
   USDC_TO_SOL:this.tickKeys(pool,data,a===USDC_MINT),
   SOL_TO_USDC:this.tickKeys(pool,data,a===SOL_MINT),
   A_TO_B:this.tickKeys(pool,data,true),
   B_TO_A:this.tickKeys(pool,data,false)
  };
  const old=this.layouts.get(pool);
  if(old){
   const previous=JSON.stringify({directions:old.directions,oracle:old.oracleAddress});
   const next=JSON.stringify({directions:dirs,oracle:oracleAddress});
   if(previous===next){
    await this.feed.reconcile([pool,...new Set(Object.values(dirs).flatMap(d=>d.map(x=>x.address))),
     ...(oracleAddress?[oracleAddress]:[])],'rpc_reconcile');
    return;
   }
  }
  const ctx=await TokenExtensionUtil.buildTokenExtensionContextForPool(
   this.fetcher,data.tokenMintA,data.tokenMintB,IGNORE_CACHE);
  if(ctx.tokenMintWithProgramA.tokenProgram.toBase58()!==TOKEN_PROGRAM||
     ctx.tokenMintWithProgramB.tokenProgram.toBase58()!==TOKEN_PROGRAM){
   this.unsupportedPools++;
   throw new Error('Token-2022 Whirlpool mint unsupported in C2 local mode');
  }
  const tickKeys=[...new Set(Object.values(dirs).flatMap(d=>d.map(x=>x.address)))];
  const watched=[...tickKeys,...(oracleAddress?[oracleAddress]:[])];
  const releases:(()=>void)[]=[];
  try{
   // Watching before the batch read avoids dropping intervening updates.
   for(const key of watched)releases.push(this.feed.watch(key));
   this.feed.setDependencies(this.dependencyPrefix+pool,[pool,...watched]);
   this.bootstrapReads++;
   await this.feed.reconcile([pool,...watched],'rpc_bootstrap');
   if(old)for(const release of old.release)release();
   this.layouts.set(pool,{pool,directions:dirs,release:releases,tokenCtx:ctx,oracleAddress});
  }catch(error){
   releases.forEach(release=>release());
   if(old){
    const oldKeys=[...new Set(Object.values(old.directions).flatMap(d=>d.map(x=>x.address)))];
    if(old.oracleAddress)oldKeys.push(old.oracleAddress);
    this.feed.setDependencies(this.dependencyPrefix+pool,[pool,...oldKeys]);
   }else this.feed.setDependencies(this.dependencyPrefix+pool,[pool]);
   throw error;
  }
 }
 validateAgainstSdk(pool:string,direction:Direction,raw:string,outputRaw:string,feeRaw:string):boolean{
  const local=this.quoteExact(pool,direction,BigInt(raw));
  if(!local)return false;
  if(local.outputRaw===outputRaw&&local.feeRaw===feeRaw){
   this.validatedAgainstSdk++;return true;
  }
  this.validationMismatches++;
  this.lastErrorReason.set(pool,'sdk_local_quote_mismatch');
  return false;
 }
 quoteExact(pool:string,direction:Direction,inputRaw:bigint,now=Date.now()):LocalQuote|null{
  if(inputRaw<=0n)return null;
  const layout=this.layouts.get(pool),decoded=this.decodePool(pool);
  if(!layout||!decoded)return null;
  const aToB=direction==='A_TO_B'||(direction!=='B_TO_A'&&
   (direction==='USDC_TO_SOL'?decoded.data.tokenMintA.toBase58()===USDC_MINT:
    decoded.data.tokenMintA.toBase58()===SOL_MINT));
  const required=this.tickKeys(pool,decoded.data,aToB);
  const known=layout.directions[direction];
  if(JSON.stringify(required)!==JSON.stringify(known)){
   this.lastErrorReason.set(pool,'tick_array_window_changed');
   return null;
  }
  const tickArrays:TickArray[]=[];
  const observations:Array<{slot:number;receivedAt:number}>=[this.verifiedObservation(decoded.observation)];
  for(const {address,startTickIndex} of required){
   const observation=this.feed.get(address);
   if(!observation){
    // A verified RPC-null at a specific slot proves that the array is
    // uninitialized in that snapshot; never invent an empty tick array
    // without a time/slot-qualified absence observation.
    const absent=this.feed.getVerifiedAbsent(address);
    if(!absent){
     this.lastErrorReason.set(pool,'tick_array_not_cached_or_not_verified_absent');
     return null;
    }
    observations.push(absent);
    tickArrays.push({address:new PublicKey(address),startTickIndex,data:null});
    continue;
   }
   if(observation.owner!==ORCA_WHIRLPOOL){
    this.lastErrorReason.set(pool,'tick_array_owner_mismatch');return null;
   }
   const parsed=ParsableTickArray.parse(new PublicKey(address),accountValue(observation));
   if(!parsed||parsed.whirlpool.toBase58()!==pool||parsed.startTickIndex!==startTickIndex){
    this.lastErrorReason.set(pool,'tick_array_decode_or_membership_failed');return null;
   }
   observations.push(this.verifiedObservation(observation));
   tickArrays.push({address:new PublicKey(address),startTickIndex,data:parsed});
  }
  let oracleData:OracleData|null=null;
  if(layout.oracleAddress){
   const observation=this.feed.get(layout.oracleAddress);
   if(!observation){this.lastErrorReason.set(pool,'oracle_missing');return null}
   if(observation.owner!==ORCA_WHIRLPOOL){
    this.lastErrorReason.set(pool,'oracle_owner_mismatch');return null;
   }
   oracleData=ParsableOracle.parse(new PublicKey(layout.oracleAddress),accountValue(observation));
   if(!oracleData){
    this.lastErrorReason.set(pool,'oracle_decode_failed');return null;
   }
   observations.push(this.verifiedObservation(observation));
  }else if(PoolUtil.isInitializedWithAdaptiveFee(decoded.data)){
   this.lastErrorReason.set(pool,'oracle_layout_missing');return null;
  }
  const valid=validateLocalComponents(observations,now,this.maxAgeMs,this.maxSlotSkew);
  if(!valid.ok){this.lastErrorReason.set(pool,valid.reason??'invalid');return null;}
  // Exact-input swap feasibility depends on account bytes, not notification
  // slots. Re-verifying identical bytes at a newer slot must not retry a
  // deterministic tick-traversal failure on every event.
  const componentKey=[decoded.observation.hash,
   ...required.map(({address})=>{
    const state=this.feed.get(address),absent=this.feed.getVerifiedAbsent(address);
    return state?state.hash:absent?'verified_uninitialized':'unknown';
   }),layout.oracleAddress?
     this.feed.get(layout.oracleAddress)?.hash??'oracle_missing':'standard_fee'].join('|');
  if(this.failureGate.blocked(pool,direction,inputRaw,componentKey))return null;
  try{
   const result=swapQuoteWithParams({
    whirlpoolData:decoded.data,tokenAmount:new BN(inputRaw.toString()),
    otherAmountThreshold:SwapUtils.getDefaultOtherAmountThreshold(true),
    sqrtPriceLimit:SwapUtils.getDefaultSqrtPriceLimit(aToB),
    aToB,amountSpecifiedIsInput:true,tickArrays,oracleData,
    tokenExtensionCtx:layout.tokenCtx,timestampInSeconds:new BN(Math.floor(now/1000))
   },Percentage.fromFraction(0,10000));
   if(result.estimatedAmountOut.lten(0))return null;
   this.localCalculations++;this.lastLocalAt=new Date(now).toISOString();
   this.verifiedUninitializedTickArrays+=tickArrays.filter(q=>q.data===null).length;
   this.lastErrorReason.delete(pool);
   this.failureGate.recover(pool,direction,inputRaw);
   const tickAt=Math.min(...observations.slice(1).map(x=>x.receivedAt));
   return {pool,direction,inputRaw:inputRaw.toString(),
    outputRaw:result.estimatedAmountOut.toString(),feeRaw:result.estimatedFeeAmount.toString(),
    observedAt:new Date(valid.oldestAt).toISOString(),poolSlot:decoded.observation.verifiedSlot,
    tickArraysObservedAt:new Date(tickAt).toISOString(),tickArraySlot:valid.minSlot,
    computedAt:new Date(now).toISOString(),quoteModel:'orca_whirlpool_sdk_in_memory'};
  }catch(error){
   const raw=String(error);
   const normalized=/traversed too many arrays|out of bounds at attempt to traverse tick index|TickArrayCrossingAboveMax/i.test(raw)
    ?'insufficient_tick_array_traversal_for_input'
    :raw;
   this.lastErrorReason.set(pool,normalized);
   if(this.failureGate.reject(pool,direction,inputRaw,componentKey,normalized)&&
      normalized!=='insufficient_tick_array_traversal_for_input')
    this.error('Local Whirlpool '+pool+' '+direction+' input='+inputRaw+': '+normalized);
   return null;
  }
 }
 isKnownUnquotable(pool:string,direction:Direction,inputRaw:bigint):boolean{
  const failure=this.failureGate.get(pool,direction,inputRaw);
  if(!failure)return false;
  const decoded=this.decodePool(pool),layout=this.layouts.get(pool);
  if(!decoded)return false;
  const required=this.tickKeys(pool,decoded.data,
   direction==='A_TO_B'||(direction!=='B_TO_A'&&
    (direction==='USDC_TO_SOL'?decoded.data.tokenMintA.toBase58()===USDC_MINT:
     decoded.data.tokenMintA.toBase58()===SOL_MINT)));
  const fingerprint=[decoded.observation.hash,...required.map(({address})=>{
   const state=this.feed.get(address),absent=this.feed.getVerifiedAbsent(address);
   return state?state.hash:absent?'verified_uninitialized':'unknown';
  }),layout?.oracleAddress?
    this.feed.get(layout.oracleAddress)?.hash??'oracle_missing':'standard_fee'].join('|');
  return fingerprint===failure.componentKey;
 }
 private verifiedObservation(obs:MarketObservation){
  return {slot:obs.verifiedSlot,receivedAt:obs.verifiedAt};
 }
 /** Refreshes unchanged account bytes with a fresh RPC verification context.
  * Prevents old but unchanged tick arrays from being permanently rejected.
  */
 async refreshCachedSnapshots():Promise<void>{
  // An active tick can cross into another array between discovery windows.
  // Reprepare newly required arrays before interpreting this pool as ready.
  for(const [pool,layout] of this.layouts){
   const decoded=this.decodePool(pool);
   if(!decoded)continue;
   const a=this.tickKeys(pool,decoded.data,true);
   const b=this.tickKeys(pool,decoded.data,false);
   const oracle=PoolUtil.isInitializedWithAdaptiveFee(decoded.data)?
    PDAUtil.getOracle(this.programId,new PublicKey(pool)).publicKey.toBase58():null;
   if(JSON.stringify(a)!==JSON.stringify(layout.directions.A_TO_B)||
      JSON.stringify(b)!==JSON.stringify(layout.directions.B_TO_A)||
      oracle!==layout.oracleAddress){
    try{await this.prepare(pool)}catch(error){
     this.lastErrorReason.set(pool,'reprepare_failed:'+String(error).slice(0,90));
    }
   }
  }
  const keys=new Set<string>();
  for(const [pool,layout] of this.layouts){
   keys.add(pool);
   for(const dir of ['A_TO_B','B_TO_A'] as const)
    for(const row of layout.directions[dir])keys.add(row.address);
   if(layout.oracleAddress)keys.add(layout.oracleAddress);
  }
  if(keys.size)await this.feed.reconcile([...keys],'rpc_reconcile');
 }
 readiness(pool:string,now=Date.now()):{ready:boolean;reason?:string}{
  const layout=this.layouts.get(pool),decoded=this.decodePool(pool);
  if(!decoded)return {ready:false,reason:'pool_state_missing'};
  if(!layout)return {ready:false,reason:'tick_arrays_not_prepared'};
  const aToB=decoded.data.tokenMintA.toBase58()===USDC_MINT;
  const required=this.tickKeys(pool,decoded.data,aToB);
  if(this.permittedMints){
   if(JSON.stringify(this.tickKeys(pool,decoded.data,true))!==
      JSON.stringify(layout.directions.A_TO_B)||
      JSON.stringify(this.tickKeys(pool,decoded.data,false))!==
      JSON.stringify(layout.directions.B_TO_A))
    return {ready:false,reason:'tick_array_window_changed'};
  }else if(JSON.stringify(required)!==JSON.stringify(layout.directions.USDC_TO_SOL))
   return {ready:false,reason:'tick_array_window_changed'};
  const pieces:Array<{slot:number;receivedAt:number}>=[
   this.verifiedObservation(decoded.observation)];
  const all=this.permittedMints?
   [...layout.directions.A_TO_B,...layout.directions.B_TO_A]:required;
  for(const {address} of all){
   const item=this.feed.get(address),absent=this.feed.getVerifiedAbsent(address);
   if(!item&&!absent)return {ready:false,reason:'tick_array_missing:'+address};
   pieces.push(item?this.verifiedObservation(item):absent!);
  }
  if(PoolUtil.isInitializedWithAdaptiveFee(decoded.data)){
   if(!layout.oracleAddress)return {ready:false,reason:'oracle_not_prepared'};
   const oracle=this.feed.get(layout.oracleAddress);
   if(!oracle)return {ready:false,reason:'oracle_missing'};
   if(oracle.owner!==ORCA_WHIRLPOOL)return {ready:false,reason:'oracle_owner_mismatch'};
   if(!ParsableOracle.parse(new PublicKey(layout.oracleAddress),accountValue(oracle)))
    return {ready:false,reason:'oracle_decode_failed'};
   pieces.push(this.verifiedObservation(oracle));
  }
  const v=validateLocalComponents(pieces,now,this.maxAgeMs,this.maxSlotSkew);
  return v.ok?{ready:true}:{ready:false,reason:v.reason};
 }
 hasReadySnapshot(pool:string,now=Date.now()):boolean{
  return this.readiness(pool,now).ready;
 }
 snapshot():LocalPricingHealth{
  let readyPools=0;
  for(const pool of this.layouts.keys())if(this.hasReadySnapshot(pool))readyPools++;
  return {trackedPools:this.layouts.size,preparedPools:this.layouts.size,readyPools,
   bootstrapReads:this.bootstrapReads,localCalculations:this.localCalculations,
   localErrors:this.localErrors,unsupportedPools:this.unsupportedPools,
   lastLocalAt:this.lastLocalAt,validatedAgainstSdk:this.validatedAgainstSdk,
   validationMismatches:this.validationMismatches,
   verifiedUninitializedTickArrays:this.verifiedUninitializedTickArrays,
   activeUnquotableSizes:this.failureGate.summary().activeFailures,
   skippedUnquotableRecomputations:this.failureGate.summary().skippedRecalculations,
   unquotableQuotes:this.failureGate.summary().failures.map(f=>({
    pool:f.pool,direction:f.direction,inputRaw:f.inputRaw,reason:f.reason,
    firstAt:f.firstAt,lastAt:f.lastAt,skipCount:f.skipCount
   })),
   errors:[...this.errors,...[...this.lastErrorReason.entries()].slice(0,3).map(([pool,reason])=>pool+': '+reason)].slice(0,10)};
 }
 forget(pool:string){
  const layout=this.layouts.get(pool);
  if(!layout)return;
  layout.release.forEach(release=>release());
  this.layouts.delete(pool);
  this.lastErrorReason.delete(pool);
  this.failureGate.clearPool(pool);
  if(this.dependencyPrefix)this.feed.clearDependencies(this.dependencyPrefix+pool);
  else this.feed.setDependencies(pool,[pool]);
 }
 /** Generic whitelisted-mint exact input with local Orca SDK. */
 quoteByInputMint(pool:string,inputMint:string,raw:bigint,now=Date.now()):LocalQuote|null{
  const data=this.decodePool(pool)?.data;
  if(!data)return null;
  const a=data.tokenMintA.toBase58(),b=data.tokenMintB.toBase58();
  if(inputMint!==a&&inputMint!==b)return null;
  return this.quoteExact(pool,inputMint===a?'A_TO_B':'B_TO_A',raw,now);
 }
 graphSnapshot(pool:string,now=Date.now()){
  const parsed=this.decodePool(pool),layout=this.layouts.get(pool);
  if(!parsed||!layout||!this.hasReadySnapshot(pool,now))return null;
  const keys=[...new Set([...layout.directions.A_TO_B,...layout.directions.B_TO_A].map(x=>x.address))];
  const values=[parsed.observation,...keys.map(k=>this.feed.get(k)??this.feed.getVerifiedAbsent(k)),
   ...(layout.oracleAddress?[this.feed.get(layout.oracleAddress)]:[])];
  if(values.some(x=>!x))return null;
  const observations=values.map(x=>x&&'verifiedSlot' in x?
   this.verifiedObservation(x as MarketObservation):x) as Array<{slot:number;receivedAt:number}>;
  const v=validateLocalComponents(observations,
   now,this.maxAgeMs,this.maxSlotSkew);
  if(!v.ok)return null;
  return {mintA:parsed.data.tokenMintA.toBase58(),mintB:parsed.data.tokenMintB.toBase58(),
   observedAt:new Date(v.oldestAt).toISOString(),poolSlot:parsed.observation.verifiedSlot,tickSlot:v.minSlot};
 }
 stop(){
  this.unsub?.();this.unsub=undefined;
  for(const pool of [...this.layouts.keys()])this.forget(pool);
 }
}
