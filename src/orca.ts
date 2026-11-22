import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {AnchorProvider,Wallet} from '@coral-xyz/anchor';
import BN from 'bn.js';
import {Percentage} from '@orca-so/common-sdk';
import {WhirlpoolContext,buildWhirlpoolClient,swapQuoteByInputToken,IGNORE_CACHE,PREFER_CACHE,type Whirlpool} from '@orca-so/whirlpools-sdk';
import {SOL_MINT,USDC_MINT,type DiscoveredPool} from './discovery.js';
import {ORCA_WHIRLPOOL} from './routes.js';
import {amountOutExactInput,type AmmV4Quote} from './ammV4.js';

export type OrcaQuote={
 pool:string;direction:'USDC_TO_SOL'|'SOL_TO_USDC';inputRaw:string;outputRaw:string;
 feeRaw:string;observedAt:string;poolSlot:number|null;classification:'indicative_non_executable';
};
export type ArbitrageCandidate={
 id:string;sizeUsd:number;buyVenue:'raydium'|'orca';sellVenue:'raydium'|'orca';
 buyPool:string;sellPool:string;inputUsdcRaw:string;outputUsdcRaw:string;
 grossUsd:number;assumedCostUsd:number;indicativeNetUsd:number;
 buyObservedAt:string;sellObservedAt:string;buySlot:number|null;sellSlot:number|null;buyLiquidityUsd?:number;sellLiquidityUsd?:number;quoteAgeGapMs:number;
 classification:'indicative_only';rejectionReasons:string[];
};
export type OrcaStatus={status:'idle'|'scanning'|'ok'|'partial_error';lastUpdatedAt?:string;
 quotedLegs:OrcaQuote[];routeCandidates:ArbitrageCandidate[];errors:string[];orcaPools:number;
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
 private addError(errors:string[],context:string,error:unknown){
  const detail=String(error);
  errors.push(`${context}: ${detail}`);
  if(/\b429\b|too many requests|rate.limit/i.test(detail)){
   this.rateLimitedUntil=Math.max(this.rateLimitedUntil,Date.now()+120000);
  }
 }
 private readonly client:ReturnType<typeof buildWhirlpoolClient>;
 private readonly ctx:WhirlpoolContext;
 private annotateLiquidity(candidate:ArbitrageCandidate):ArbitrageCandidate{
  const buy=this.pools.find(p=>p.address===candidate.buyPool);
  const sell=this.pools.find(p=>p.address===candidate.sellPool);
  return {...candidate,buyLiquidityUsd:buy?.liquidityUsd,sellLiquidityUsd:sell?.liquidityUsd};
 }
 constructor(private readonly connection:Connection,private readonly pools:DiscoveredPool[],
   private readonly sizesUsd:number[],private readonly getRaydiumQuotes:()=>AmmV4Quote[],
   private readonly assumedCostUsd:number,private readonly intervalMs=60000,private readonly minLiquidityUsd=0){
  // Ephemeral, unused local signing identity required by legacy SDK provider.
  // This service NEVER signs or broadcasts transactions.
  const provider=new AnchorProvider(connection,new Wallet(Keypair.generate()),{commitment:'confirmed'});
  this.ctx=WhirlpoolContext.withProvider(provider);
  this.client=buildWhirlpoolClient(this.ctx);
 }
 snapshot():OrcaStatus{return {...this.state,quotedLegs:[...this.state.quotedLegs],routeCandidates:[...this.state.routeCandidates],errors:[...this.state.errors]};}
 private async preparePool(poolAddress:string):Promise<{pool:Whirlpool;poolSlot:number}>{
  const address=new PublicKey(poolAddress);
  const account=await this.connection.getAccountInfoAndContext(address,'confirmed');
  if(!account.value||account.value.owner.toBase58()!==ORCA_WHIRLPOOL)throw new Error('Invalid Whirlpool owner');
  // Only one fresh pool fetch per cycle. No per-size reloading of the same pool.
  const pool=await this.client.getPool(address,IGNORE_CACHE);
  const data=pool.getData();
  const a=data.tokenMintA.toBase58(),b=data.tokenMintB.toBase58();
  if(!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))throw new Error('Unexpected Whirlpool token mints');
  return {pool,poolSlot:account.context.slot};
 }
 private async quote(poolAddress:string,pool:Whirlpool,poolSlot:number,direction:'USDC_TO_SOL'|'SOL_TO_USDC',inputRaw:bigint,refreshTicks:boolean):Promise<OrcaQuote>{
  if(inputRaw<=0n)throw new Error('Invalid quote amount');
  const inputMint=direction==='USDC_TO_SOL'?USDC_MINT:SOL_MINT;
  // Refresh tick arrays once per direction per cycle; subsequent size quotes use
  // that cycle's cached arrays. This reduces RPC load but does not ensure a coherent slot.
  const result=await swapQuoteByInputToken(pool,new PublicKey(inputMint),new BN(inputRaw.toString()),
   Percentage.fromFraction(0,10000),this.ctx.program.programId,this.client.getFetcher(),refreshTicks?IGNORE_CACHE:PREFER_CACHE);
  if(result.estimatedAmountOut.isNeg()||result.estimatedAmountOut.isZero())throw new Error('No output in Whirlpool quote');
  return {pool:poolAddress,direction,inputRaw:inputRaw.toString(),outputRaw:result.estimatedAmountOut.toString(),
   feeRaw:result.estimatedFeeAmount.toString(),observedAt:new Date().toISOString(),
   poolSlot,classification:'indicative_non_executable'};
 }
 async scanOnce(){
  if(this.busy)return;
  if(Date.now()<this.rateLimitedUntil){
   this.state={...this.state,status:'partial_error',errors:[`Rate-limit cooldown active until ${new Date(this.rateLimitedUntil).toISOString()}`]};
   return;
  }
  this.busy=true;
  const orca=this.pools.filter(p=>(p.venue==='orca'||p.venue==='manual')&&p.owner===ORCA_WHIRLPOOL && (p.liquidityUsd===undefined||p.liquidityUsd>=this.minLiquidityUsd));
  this.state={...this.state,status:'scanning',progress:{totalPools:orca.length,completedPools:0,quotesCompleted:0,routesEstimated:0}};
  const legs:OrcaQuote[]=[],candidates:ArbitrageCandidate[]=[],errors:string[]=[];
  try{
   const rayQuotes=this.getRaydiumQuotes();
   if(!rayQuotes.length)errors.push('No Raydium AMM v4 quotes available. Check /amm-v4 status and errors; cannot create cross-DEX routes.');
   const bySize=new Map<number,AmmV4Quote[]>();
   for(const q of rayQuotes){const size=Number(BigInt(q.inputRaw))/1e6;bySize.set(size,[...(bySize.get(size)??[]),q]);}
   let completed=0;
   for(const pool of orca){
    if(this.rateLimitedUntil>Date.now())break;
    this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address}};
    let prepared: {pool:Whirlpool;poolSlot:number};
    try{prepared=await this.preparePool(pool.address);}
    catch(e){this.addError(errors,`Orca pool ${pool.address}`,e);completed++;if(this.rateLimitedUntil>Date.now())break;continue;}
    let buyTicksRefreshed=false;
    let sellTicksRefreshed=false;
    for(const size of this.sizesUsd){
     if(this.rateLimitedUntil>Date.now())break;
     this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address,currentSizeUsd:size}};
     const amount=BigInt(Math.round(size*1e6));
     try{
      const buy=await this.quote(pool.address,prepared.pool,prepared.poolSlot,'USDC_TO_SOL',amount,!buyTicksRefreshed);buyTicksRefreshed=true;legs.push(buy);
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
      // Buy Raydium, sell Orca at EXACT amount produced by first leg.
      for(const ray of bySize.get(size)??[]){
       try{
        const sell=await this.quote(pool.address,prepared.pool,prepared.poolSlot,'SOL_TO_USDC',BigInt(ray.outputRaw),!sellTicksRefreshed);sellTicksRefreshed=true;legs.push(sell);
        candidates.push(this.annotateLiquidity(evaluateRoute(size,
         {pool:ray.pool,venue:'raydium',inputRaw:ray.inputRaw,outputRaw:ray.outputRaw,observedAt:ray.observedAt,slot:ray.vaultSlot},
         {pool:pool.address,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},
         this.assumedCostUsd)));
       }catch(e){this.addError(errors,`Raydium->Orca ${ray.pool}/${pool.address}`,e);}
      }
     }catch(e){this.addError(errors,`${pool.address} ${size}`,e);}
     this.state={...this.state,progress:{totalPools:orca.length,completedPools:completed,quotesCompleted:legs.length,routesEstimated:candidates.length,currentPool:pool.address,currentSizeUsd:size}};
    }
    completed++;
   }
  }finally{
   this.busy=false;
   this.state={status:errors.length?'partial_error':'ok',lastUpdatedAt:new Date().toISOString(),
    quotedLegs:legs,routeCandidates:candidates,errors,orcaPools:orca.length,progress:{totalPools:orca.length,completedPools:orca.length,quotesCompleted:legs.length,routesEstimated:candidates.length}};
  }
 }
 start(){if(this.running)return;this.running=true;const loop=async()=>{if(!this.running)return;try{await this.scanOnce();}catch(e){this.state={...this.state,status:'partial_error',errors:[String(e)]};}if(this.running)this.timer=setTimeout(()=>{void loop();},this.intervalMs);};void loop();}
 stop(){this.running=false;if(this.timer)clearTimeout(this.timer);}
}
