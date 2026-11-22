import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {AnchorProvider,Wallet} from '@coral-xyz/anchor';
import BN from 'bn.js';
import {Percentage} from '@orca-so/common-sdk';
import {WhirlpoolContext,buildWhirlpoolClient,swapQuoteByInputToken,IGNORE_CACHE,PREFER_CACHE,type Whirlpool} from '@orca-so/whirlpools-sdk';
import {SOL_MINT,USDC_MINT,type DiscoveredPool} from './discovery.js';
import {ORCA_WHIRLPOOL} from './routes.js';
import {amountOutExactInput,type AmmV4Quote} from './ammV4.js';
import {LastKnownQuoteBook} from './quoteBook.js';
import {LocalWhirlpoolQuoter,type LocalPricingHealth} from './localWhirlpool.js';
import type {MarketDataFeed} from './marketData.js';

export type OrcaQuote={
 pool:string;direction:'USDC_TO_SOL'|'SOL_TO_USDC';inputRaw:string;outputRaw:string;
 feeRaw:string;observedAt:string;computedAt?:string;tickArraysObservedAt?:string;tickArraySlot?:number|null;poolSlot:number|null;
 quoteModel?:'orca_whirlpool_sdk_rpc'|'orca_whirlpool_sdk_in_memory';invalidated?:boolean;classification:'indicative_non_executable';
};
export type ArbitrageCandidate={
 id:string;sizeUsd:number;buyVenue:'raydium'|'orca';sellVenue:'raydium'|'orca';
 buyPool:string;sellPool:string;inputUsdcRaw:string;outputUsdcRaw:string;
 grossUsd:number;assumedCostUsd:number;indicativeNetUsd:number;
 buyObservedAt:string;sellObservedAt:string;buySlot:number|null;sellSlot:number|null;buyLiquidityUsd?:number;sellLiquidityUsd?:number;raydiumModel?:'amm_v4'|'clmm';quoteAgeGapMs:number;
 classification:'indicative_only';rejectionReasons:string[];
};
export type OrcaStatus={status:'idle'|'scanning'|'ok'|'partial_error';lastUpdatedAt?:string;
 quotedLegs:OrcaQuote[];routeCandidates:ArbitrageCandidate[];errors:string[];orcaPools:number;
 quoteState?:'warming'|'refreshing'|'fresh'|'expired';
 freshLegs?:number;expiredLegs?:number;
 poolFreshness?:Array<{pool:string;refreshing:boolean;lastCompletedAt?:string;legs:number}>;
 tickArraysSlotVerified?:false;
 quoteMode?:'fast'|'full';lastScanDurationMs?:number;lastFirstBuyDelayMs?:number;
 lastBuyCount?:number;lastReverseCount?:number;lastPoolSetupMs?:number;
 localPricing?:LocalPricingHealth;
 invalidatedPools?:string[];skippedUnquotablePools?:number;
 referenceValidation?:{
  running:boolean;requests:number;rejectedRequests:number;checks:number;matches:number;mismatches:number;inconclusive:number;
  lastRejection?:string;
  last?:{pool:string;status:'running'|'match'|'mismatch'|'inconclusive'|'error';localRaw?:string;
   sdkRaw?:string;deltaRaw?:string;poolSlot?:number;sdkPoolSlot?:number;
   durationMs:number;checkedAt:string;reason:string};
 };
 progress?:{totalPools:number;completedPools:number;quotesCompleted:number;routesEstimated:number;currentPool?:string;currentSizeUsd?:number};};

export function evaluateRoute(
 sizeUsd:number,buy:{pool:string;venue:'raydium'|'orca';inputRaw:string;outputRaw:string;observedAt:string;slot?:number|null},
 sell:{pool:string;venue:'raydium'|'orca';inputRaw:string;outputRaw:string;observedAt:string;slot?:number|null},
 assumedCostUsd:number
):ArbitrageCandidate{
 const expected=BigInt(Math.round(sizeUsd*1e6));
 if(buy.venue===sell.venue||buy.pool===sell.pool)throw new Error('Route must cross distinct venues and pools');
 if(BigInt(buy.inputRaw)!==expected||sell.inputRaw!==buy.outputRaw)throw new Error('Non-contiguous route input/output');
 const grossRaw=BigInt(sell.outputRaw)-expected;
 const grossUsd=Number(grossRaw)/1e6;
 const gap=Math.abs(Date.parse(buy.observedAt)-Date.parse(sell.observedAt));
 if(!Number.isFinite(gap))throw new Error('Invalid route timestamps');
 return {id:`${buy.pool}:${sell.pool}:${expected}`,sizeUsd,buyPool:buy.pool,sellPool:sell.pool,
  buyVenue:buy.venue,sellVenue:sell.venue,inputUsdcRaw:expected.toString(),
  outputUsdcRaw:sell.outputRaw,grossUsd,assumedCostUsd,indicativeNetUsd:grossUsd-assumedCostUsd,
  buyObservedAt:buy.observedAt,sellObservedAt:sell.observedAt,buySlot:buy.slot??null,sellSlot:sell.slot??null,quoteAgeGapMs:gap,
  classification:'indicative_only',
  rejectionReasons:['not_atomic_transaction_simulation','independent_pool_snapshots','fee_and_landing_costs_unverified',...(gap>2000?['quote_time_gap_over_2s']:[])]};
}

export class OrcaMonitor{
 private state:OrcaStatus={status:'idle',quotedLegs:[],routeCandidates:[],errors:[],orcaPools:0};
 private running=false;private timer?:ReturnType<typeof setTimeout>;private busy=false;
 private rateLimitedUntil=0;
 private readonly book=new LastKnownQuoteBook<OrcaQuote>();
 private readonly invalidatedPools=new Set<string>();
 private readonly tickObservedAt=new Map<string,string>();
 private addError(errors:string[],context:string,error:unknown){
  const detail=String(error);
  errors.push(`${context}: ${detail}`);
  if(/\b429\b|too many requests|rate.limit/i.test(detail)){
   this.rateLimitedUntil=Math.max(this.rateLimitedUntil,Date.now()+120000);
  }
 }
 private readonly client:ReturnType<typeof buildWhirlpoolClient>;
 private readonly ctx:WhirlpoolContext;
 private readonly local?:LocalWhirlpoolQuoter;
 private validationRunning=false;
 private validationRequests=0;private validationRejectedRequests=0;
 private lastValidationRejection?:string;
 private referenceChecks=0;private referenceMatches=0;
 private referenceMismatches=0;private referenceInconclusive=0;
 private lastReference?:NonNullable<OrcaStatus['referenceValidation']>['last'];
 private annotateLiquidity(candidate:ArbitrageCandidate):ArbitrageCandidate{
  const buy=this.pools.find(p=>p.address===candidate.buyPool);
  const sell=this.pools.find(p=>p.address===candidate.sellPool);
  return {...candidate,buyLiquidityUsd:buy?.liquidityUsd,sellLiquidityUsd:sell?.liquidityUsd};
 }
 constructor(private readonly connection:Connection,private readonly pools:DiscoveredPool[],
   private readonly sizesUsd:number[],private readonly getRaydiumQuotes:()=>AmmV4Quote[],
   private readonly assumedCostUsd:number,private readonly intervalMs=60000,private readonly minLiquidityUsd=0,
   private readonly onLeg?:()=>void,
   private readonly maxQuoteAgeMs=15000,
   private readonly getExtraBuys?:()=>Array<{pool:string;inputRaw:string;outputRaw:string;observedAt:string;slot:number|null}>,
   private readonly quoteMode:'fast'|'full'='fast',
   private readonly onFirstBuy?:()=>void,
   private readonly marketData?:MarketDataFeed,
   private readonly maxLocalSlotSkew=12){
  // Ephemeral, unused local signing identity required by legacy SDK provider.
  // This service NEVER signs or broadcasts transactions.
  const provider=new AnchorProvider(connection,new Wallet(Keypair.generate()),{commitment:'confirmed'});
  this.ctx=WhirlpoolContext.withProvider(provider);
  this.client=buildWhirlpoolClient(this.ctx);
  if(this.marketData)this.local=new LocalWhirlpoolQuoter(
   this.marketData,this.ctx.program.programId,this.client.getFetcher(),
   this.maxQuoteAgeMs,this.maxLocalSlotSkew,pool=>this.refreshLocalFromEvent(pool));
 }
 snapshot():OrcaStatus{
  const now=Date.now(),b=this.book.snapshot(now,this.maxQuoteAgeMs);
  const quoteLegs=b.entries.map(q=>({...q,invalidated:this.invalidatedPools.has(q.pool)}));
  const freshLegs=quoteLegs.filter(q=>!q.invalidated&&
   Number.isFinite(Date.parse(q.observedAt))&&
   now-Date.parse(q.observedAt)<=this.maxQuoteAgeMs&&
   Date.parse(q.observedAt)<=now+1000).length;
  const quoteState=this.state.status==='scanning'?'refreshing':
   !quoteLegs.length?'warming':freshLegs?'fresh':'expired';
  return {...this.state,quoteMode:this.quoteMode,quotedLegs:quoteLegs,quoteState,
   freshLegs,expiredLegs:quoteLegs.length-freshLegs,poolFreshness:b.poolStatus,
   invalidatedPools:[...this.invalidatedPools],
   tickArraysSlotVerified:false,localPricing:this.local?.snapshot(),
   referenceValidation:{running:this.validationRunning,requests:this.validationRequests,
    rejectedRequests:this.validationRejectedRequests,lastRejection:this.lastValidationRejection,
    checks:this.referenceChecks,
    matches:this.referenceMatches,mismatches:this.referenceMismatches,
    inconclusive:this.referenceInconclusive,last:this.lastReference},
   routeCandidates:[...this.state.routeCandidates],errors:[...this.state.errors]};
 }
 hasLocalPricing(pool:string):boolean{return this.local?.hasReadySnapshot(pool)??false;}
 requestReferenceValidation():{accepted:boolean;message:string}{
  const reject=(message:string)=>{
   this.validationRejectedRequests++;this.lastValidationRejection=message;
   return {accepted:false,message};
  };
  if(this.validationRunning)return reject('C2 SDK reference comparison is already in progress');
  if(this.busy)return reject('Orca RPC scan is running; retry when scanning finishes');
  if(!this.local)return reject('Local C2 quoting is disabled');
  const raw=BigInt(Math.round(this.sizesUsd[0]*1e6));
  // Cache-ready does not imply a successful swap: a small, narrow Whirlpool
  // may traverse beyond its initialized arrays at the requested input.
  const pool=this.pools.find(p=>p.owner===ORCA_WHIRLPOOL&&
   (p.venue==='orca'||p.venue==='manual')&&
   this.local?.hasReadySnapshot(p.address)&&
   this.local?.quoteExact(p.address,'USDC_TO_SOL',raw));
  if(!pool)return reject('No quotable cached Whirlpool at input '+this.sizesUsd[0]+
   ' USDC; inspect /api/c2 or retry after a pool/tick update');
  this.validationRunning=true;
  this.validationRequests++;
  this.lastValidationRejection=undefined;
  this.lastReference={pool:pool.address,status:'running',durationMs:0,
   checkedAt:new Date().toISOString(),
   reason:'Read-only independent SDK/RPC quote comparison in progress'};
  void this.performReferenceValidation(pool.address,raw).catch(error=>{
   // Keep failures visible even when an unexpected throw escapes the normal
   // quote-check path. Acknowledge only an actually started request.
   this.referenceChecks++;this.referenceInconclusive++;
   this.lastReference={pool:pool.address,status:'error',
    checkedAt:new Date().toISOString(),durationMs:0,
    reason:'Unhandled C2 comparison error: '+String(error)};
  }).finally(()=>{this.validationRunning=false;});
  return {accepted:true,message:'C2 SDK comparison started; poll /api/c2 until running=false'};
 }
 private async performReferenceValidation(poolAddress:string,raw:bigint):Promise<void>{
  const started=Date.now(),observed=new Date().toISOString();
  let status:'match'|'mismatch'|'inconclusive'|'error'='inconclusive';
  let localRaw:string|undefined,sdkRaw:string|undefined,deltaRaw:string|undefined;
  let poolSlot:number|undefined,sdkPoolSlot:number|undefined;
  let reason='different RPC/tick-array contexts are not execution verification';
  try{
   const before=this.local?.quoteExact(poolAddress,'USDC_TO_SOL',raw);
   if(!before)throw new Error('Local quote expired before SDK cross-check');
   localRaw=before.outputRaw;poolSlot=before.poolSlot;
   const prepared=await this.preparePool(poolAddress);
   sdkPoolSlot=prepared.poolSlot;
   const sdk=await swapQuoteByInputToken(prepared.pool,new PublicKey(USDC_MINT),
    new BN(raw.toString()),Percentage.fromFraction(0,10000),
    this.ctx.program.programId,this.client.getFetcher(),IGNORE_CACHE);
   sdkRaw=sdk.estimatedAmountOut.toString();
   const after=this.local?.quoteExact(poolAddress,'USDC_TO_SOL',raw);
   if(!after||after.poolSlot!==before.poolSlot||
      after.outputRaw!==before.outputRaw||prepared.poolSlot!==before.poolSlot){
    status='inconclusive';
    reason='Local or SDK pool state changed during separate reads; comparison not slot-identical';
    this.referenceInconclusive++;
   }else{
    deltaRaw=(BigInt(sdkRaw)-BigInt(localRaw)).toString();
    const matched=this.local!.validateAgainstSdk(poolAddress,'USDC_TO_SOL',raw.toString(),
     sdkRaw,sdk.estimatedFeeAmount.toString());
    status=matched?'match':'mismatch';
    reason=matched?'Exact raw output and fee match against RPC SDK; tick-array slots still not proven identical':
     'Local output or fee differs; SDK tick-array snapshots may be from different slots';
    if(matched)this.referenceMatches++;else this.referenceMismatches++;
   }
   this.referenceChecks++;
  }catch(error){
   status='error';reason=String(error);this.referenceChecks++;this.referenceInconclusive++;
  }finally{
   this.lastReference={pool:poolAddress,status,localRaw,sdkRaw,deltaRaw,
    poolSlot,sdkPoolSlot,durationMs:Date.now()-started,checkedAt:observed,reason};
  }
 }
 private refreshLocalFromEvent(pool:string){
  if(!this.local)return;
  // Compute from cached account bytes on the WebSocket callback path:
  // no SDK/RPC calls, no observedAt fabrication. Only successful entire
  // generations replace the previously published pool quotes.
  const legs:OrcaQuote[]=[];
  for(const size of this.sizesUsd){
   const amount=BigInt(Math.round(size*1e6));
   const q=this.local.quoteExact(pool,'USDC_TO_SOL',amount);
   if(q)legs.push({...q,classification:'indicative_non_executable'});
  }
  if(!legs.length){
   // A newer pool/tick update has invalidated last-known pricing. Preserve
   // it for UI inspection but never rank it as a fresh arbitrage leg.
   this.invalidatedPools.add(pool);
   try{this.onLeg?.();}catch(error){this.addError(this.state.errors,'Invalidate quote callback',error);}
   return;
  }
  this.book.begin(pool);
  for(const quote of legs)this.publishLegs(quote);
  this.book.complete(pool,new Date().toISOString());
 }
 private publishLegs(leg:OrcaQuote){
  this.invalidatedPools.delete(leg.pool);
  this.book.publish(leg);
  this.state={...this.state,quotedLegs:this.book.snapshot(Date.now(),this.maxQuoteAgeMs).entries};
  try{this.onLeg?.();}catch(error){this.addError(this.state.errors,'Orca quote progress callback',error);}
 }
 private async preparePool(poolAddress:string):Promise<{pool:Whirlpool;poolSlot:number;observedAt:string}>{
  const address=new PublicKey(poolAddress);
  const account=await this.connection.getAccountInfoAndContext(address,'confirmed');
  const observedAt=new Date().toISOString();
  if(!account.value||account.value.owner.toBase58()!==ORCA_WHIRLPOOL)throw new Error('Invalid Whirlpool owner');
  // Only one fresh pool fetch per cycle. No per-size reloading of the same pool.
  const pool=await this.client.getPool(address,IGNORE_CACHE);
  const data=pool.getData();
  const a=data.tokenMintA.toBase58(),b=data.tokenMintB.toBase58();
  if(!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))throw new Error('Unexpected Whirlpool token mints');
  return {pool,poolSlot:account.context.slot,observedAt};
 }
 private async quote(poolAddress:string,pool:Whirlpool|null,poolSlot:number,poolObservedAt:string,direction:'USDC_TO_SOL'|'SOL_TO_USDC',inputRaw:bigint,refreshTicks:boolean):Promise<OrcaQuote>{
  if(inputRaw<=0n)throw new Error('Invalid quote amount');
  const local=this.local?.quoteExact(poolAddress,direction,inputRaw);
  if(local)return {...local,classification:'indicative_non_executable'};
  if(this.local?.isKnownUnquotable(poolAddress,direction,inputRaw))
   throw new Error('C2 exact-input quote unavailable within covered tick-array range');
  if(!pool)throw new Error('Local pool state unavailable and SDK fallback not initialized');
  const inputMint=direction==='USDC_TO_SOL'?USDC_MINT:SOL_MINT;
  // Refresh tick arrays once per direction per cycle; subsequent size quotes use
  // that cycle's cached arrays. This reduces RPC load but does not ensure a coherent slot.
  const tickKey=poolAddress+':'+direction;
  const tickReadStart=refreshTicks?new Date().toISOString():this.tickObservedAt.get(tickKey);
  const result=await swapQuoteByInputToken(pool,new PublicKey(inputMint),new BN(inputRaw.toString()),
   Percentage.fromFraction(0,10000),this.ctx.program.programId,this.client.getFetcher(),refreshTicks?IGNORE_CACHE:PREFER_CACHE);
  if(result.estimatedAmountOut.isNeg()||result.estimatedAmountOut.isZero())throw new Error('No output in Whirlpool quote');
  if(refreshTicks&&tickReadStart)this.tickObservedAt.set(tickKey,tickReadStart);
  return {pool:poolAddress,direction,inputRaw:inputRaw.toString(),outputRaw:result.estimatedAmountOut.toString(),
   feeRaw:result.estimatedFeeAmount.toString(),observedAt:poolObservedAt,computedAt:new Date().toISOString(),
   tickArraysObservedAt:tickReadStart,tickArraySlot:null,
   poolSlot,quoteModel:'orca_whirlpool_sdk_rpc',
   classification:'indicative_non_executable'};
 }
 async scanOnce(onlyPools?:ReadonlySet<string>){
  if(this.busy)return;
  if(Date.now()<this.rateLimitedUntil){
   this.state={...this.state,status:'partial_error',errors:[`Rate-limit cooldown active until ${new Date(this.rateLimitedUntil).toISOString()}`]};
   return;
  }
  this.busy=true;
  const startedAt=Date.now();
  let firstBuyAt=0,buyCount=0,reverseCount=0,poolSetupMs=0,skippedUnquotablePools=0;
  const allOrca=this.pools.filter(p=>(p.venue==='orca'||p.venue==='manual')&&p.owner===ORCA_WHIRLPOOL && (p.liquidityUsd===undefined||p.liquidityUsd>=this.minLiquidityUsd));
  const orca=onlyPools?allOrca.filter(p=>onlyPools.has(p.address)):allOrca;
  this.state={...this.state,status:'scanning',progress:{totalPools:orca.length,completedPools:0,quotesCompleted:0,routesEstimated:0}};
  const legs:OrcaQuote[]=[],candidates:ArbitrageCandidate[]=[],errors:string[]=[];
  try{
   const rayQuotes=this.quoteMode==='full'?this.getRaydiumQuotes():[];
   if(this.quoteMode==='full'&&!rayQuotes.length)errors.push('No Raydium AMM v4 quotes available. Check /amm-v4 status and errors; cannot create cross-DEX routes.');
   const bySize=new Map<number,AmmV4Quote[]>();
   for(const q of rayQuotes){const size=Number(BigInt(q.inputRaw))/1e6;bySize.set(size,[...(bySize.get(size)??[]),q]);}
   const extraBuys=this.quoteMode==='full'?(this.getExtraBuys?.()??[]):[];
   const extraBySize=new Map<number,typeof extraBuys>();
   for(const q of extraBuys){
    const size=Number(BigInt(q.inputRaw))/1e6;
    extraBySize.set(size,[...(extraBySize.get(size)??[]),q]);
   }
   let completed=0;
   for(const pool of orca){
    if(this.rateLimitedUntil>Date.now())break;
    this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address}};
    let prepared: {pool:Whirlpool|null;poolSlot:number;observedAt:string}|undefined;
    try{
     const prepStartedAt=Date.now();
     if(this.local){
      try{await this.local.prepare(pool.address);}
      catch(error){this.addError(errors,'C2 cache bootstrap '+pool.address,error);}
      const raw=BigInt(Math.round(this.sizesUsd[0]*1e6));
      const cached=this.local.quoteExact(pool.address,'USDC_TO_SOL',raw);
      if(cached)prepared={pool:null,poolSlot:cached.poolSlot,observedAt:cached.observedAt};
      else if(this.local.isKnownUnquotable(pool.address,'USDC_TO_SOL',raw)){
       this.invalidatedPools.add(pool.address);
       skippedUnquotablePools++;
       completed++;
       continue;
      }
     }
     if(!prepared)prepared=await this.preparePool(pool.address);
     poolSetupMs+=Date.now()-prepStartedAt;
     this.book.begin(pool.address);
    }
    catch(e){this.addError(errors,`Orca pool ${pool.address}`,e);completed++;if(this.rateLimitedUntil>Date.now())break;continue;}
    let buyTicksRefreshed=false;
    let sellTicksRefreshed=false;
    for(const size of this.sizesUsd){
     if(this.rateLimitedUntil>Date.now())break;
     this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address,currentSizeUsd:size}};
     const amount=BigInt(Math.round(size*1e6));
     try{
      const buy=await this.quote(pool.address,prepared.pool,prepared.poolSlot,prepared.observedAt,'USDC_TO_SOL',amount,!buyTicksRefreshed);buyTicksRefreshed=true;
      buyCount++;
      if(!firstBuyAt){
       firstBuyAt=Date.now();
       try{this.onFirstBuy?.();}catch(error){this.addError(errors,'First buy sync callback',error);}
      }
      legs.push(buy);this.publishLegs(buy);
      // Buy Orca, sell Raydium using each known Raydium pool's USDC-side output reserve.
      for(const ray of bySize.get(size)??[]){
       try{
        const solIn=BigInt(buy.outputRaw),feeNum=BigInt(ray.feeNumerator),feeDen=BigInt(ray.feeDenominator);
        const output=amountOutExactInput(solIn,BigInt(ray.reserveOutRaw),BigInt(ray.reserveInRaw),feeNum,feeDen);
        const candidate=evaluateRoute(size,{pool:pool.address,venue:'orca',inputRaw:buy.inputRaw,outputRaw:buy.outputRaw,observedAt:buy.observedAt,slot:buy.poolSlot},
         {pool:ray.pool,venue:'raydium',inputRaw:buy.outputRaw,outputRaw:output.toString(),observedAt:ray.observedAt,slot:ray.vaultSlot},this.assumedCostUsd);
        candidates.push(this.annotateLiquidity(candidate));
       }catch(e){this.addError(errors,`Orca->Raydium ${pool.address}/${ray.pool}`,e);}
      }
      if(this.quoteMode==='full'){
      // Buy Raydium, sell Orca at EXACT amount produced by first leg.
      for(const ray of bySize.get(size)??[]){
       try{
        const sell=await this.quote(pool.address,prepared.pool,prepared.poolSlot,prepared.observedAt,'SOL_TO_USDC',BigInt(ray.outputRaw),!sellTicksRefreshed);sellTicksRefreshed=true;reverseCount++;legs.push(sell);this.publishLegs(sell);
        candidates.push(this.annotateLiquidity(evaluateRoute(size,
         {pool:ray.pool,venue:'raydium',inputRaw:ray.inputRaw,outputRaw:ray.outputRaw,observedAt:ray.observedAt,slot:ray.vaultSlot},
         {pool:pool.address,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},
         this.assumedCostUsd)));
       }catch(e){this.addError(errors,`Raydium->Orca ${ray.pool}/${pool.address}`,e);}
      }
      // CLMM first-leg outputs require an Orca reverse SDK quote at that
      // EXACT SOL input. Never interpolate from another output amount.
      for(const clmm of extraBySize.get(size)??[]){
       try{
        const reverse=await this.quote(pool.address,prepared.pool,prepared.poolSlot,prepared.observedAt,
         'SOL_TO_USDC',BigInt(clmm.outputRaw),!sellTicksRefreshed);
        sellTicksRefreshed=true;reverseCount++;legs.push(reverse);this.publishLegs(reverse);
        candidates.push(this.annotateLiquidity(evaluateRoute(size,
         {pool:clmm.pool,venue:'raydium',inputRaw:clmm.inputRaw,outputRaw:clmm.outputRaw,
          observedAt:clmm.observedAt,slot:clmm.slot},
         {pool:pool.address,venue:'orca',inputRaw:reverse.inputRaw,outputRaw:reverse.outputRaw,
          observedAt:reverse.observedAt,slot:reverse.poolSlot},this.assumedCostUsd)));
       }catch(e){this.addError(errors,'CLMM->Orca '+clmm.pool+'/'+pool.address,e);}
      }
      }
     }catch(e){this.addError(errors,`${pool.address} ${size}`,e);}
     this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address,currentSizeUsd:size}};
    }
    this.book.complete(pool.address,new Date().toISOString());
    completed++;
   }
  }finally{
   this.busy=false;
   const retain=new Set(allOrca.map(p=>p.address));
   this.book.retain(retain);
   for(const pool of [...this.invalidatedPools])if(!retain.has(pool))this.invalidatedPools.delete(pool);
   for(const pool of orca)this.book.fail(pool.address);
   this.state={status:errors.length?'partial_error':'ok',lastUpdatedAt:new Date().toISOString(),
    quotedLegs:this.book.snapshot(Date.now(),this.maxQuoteAgeMs).entries,routeCandidates:candidates,
    quoteMode:this.quoteMode,lastScanDurationMs:Date.now()-startedAt,
    lastFirstBuyDelayMs:firstBuyAt?firstBuyAt-startedAt:undefined,
    lastBuyCount:buyCount,lastReverseCount:reverseCount,lastPoolSetupMs:poolSetupMs,
    skippedUnquotablePools,
    errors,orcaPools:allOrca.length,progress:{totalPools:orca.length,completedPools:orca.length,quotesCompleted:legs.length,routesEstimated:candidates.length}};
  }
 }
 start(){if(this.running)return;this.running=true;const loop=async()=>{if(!this.running)return;try{await this.scanOnce();}catch(e){this.state={...this.state,status:'partial_error',errors:[String(e)]};}if(this.running)this.timer=setTimeout(()=>{void loop();},this.intervalMs);};void loop();}
 stop(){this.running=false;if(this.timer)clearTimeout(this.timer);this.local?.stop();}
}
