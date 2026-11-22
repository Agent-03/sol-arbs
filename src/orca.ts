import {Connection,Keypair,PublicKey} from '@solana/web3.js';
import {AnchorProvider,Wallet} from '@coral-xyz/anchor';
import BN from 'bn.js';
import {Percentage} from '@orca-so/common-sdk';
import {WhirlpoolContext,buildWhirlpoolClient,swapQuoteByInputToken,IGNORE_CACHE,ORCA_WHIRLPOOL_PROGRAM_ID} from '@orca-so/whirlpools-sdk';
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
 buyObservedAt:string;sellObservedAt:string;quoteAgeGapMs:number;
 classification:'indicative_only';rejectionReasons:string[];
};
export type OrcaStatus={status:'idle'|'scanning'|'ok'|'partial_error';lastUpdatedAt?:string;
 quotedLegs:OrcaQuote[];routeCandidates:ArbitrageCandidate[];errors:string[];orcaPools:number;};

export function evaluateRoute(
 sizeUsd:number,buy:{pool:string;venue:'raydium'|'orca';inputRaw:string;outputRaw:string;observedAt:string},
 sell:{pool:string;venue:'raydium'|'orca';inputRaw:string;outputRaw:string;observedAt:string},
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
  buyObservedAt:buy.observedAt,sellObservedAt:sell.observedAt,quoteAgeGapMs:gap,
  classification:'indicative_only',
  rejectionReasons:['not_atomic_transaction_simulation','independent_pool_snapshots','fee_and_landing_costs_unverified',...(gap>2000?['quote_time_gap_over_2s']:[])]};
}

export class OrcaMonitor{
 private state:OrcaStatus={status:'idle',quotedLegs:[],routeCandidates:[],errors:[],orcaPools:0};
 private running=false;private timer?:ReturnType<typeof setTimeout>;private busy=false;
 private readonly client:ReturnType<typeof buildWhirlpoolClient>;
 private readonly ctx:WhirlpoolContext;
 constructor(private readonly connection:Connection,private readonly pools:DiscoveredPool[],
   private readonly sizesUsd:number[],private readonly getRaydiumQuotes:()=>AmmV4Quote[],
   private readonly assumedCostUsd:number,private readonly intervalMs=15000){
  // Ephemeral, unused local signing identity required by legacy SDK provider.
  // This service NEVER signs or broadcasts transactions.
  const provider=new AnchorProvider(connection,new Wallet(Keypair.generate()),{commitment:'confirmed'});
  this.ctx=WhirlpoolContext.withProvider(provider,ORCA_WHIRLPOOL_PROGRAM_ID);
  this.client=buildWhirlpoolClient(this.ctx);
 }
 snapshot():OrcaStatus{return {...this.state,quotedLegs:[...this.state.quotedLegs],routeCandidates:[...this.state.routeCandidates],errors:[...this.state.errors]};}
 private async quote(poolAddress:string,direction:'USDC_TO_SOL'|'SOL_TO_USDC',inputRaw:bigint):Promise<OrcaQuote>{
  if(inputRaw<=0n)throw new Error('Invalid quote amount');
  const address=new PublicKey(poolAddress);
  const account=await this.connection.getAccountInfoAndContext(address,'confirmed');
  if(!account.value||account.value.owner.toBase58()!==ORCA_WHIRLPOOL)throw new Error('Invalid Whirlpool owner');
  const pool=await this.client.getPool(address);
  const data=pool.getData();
  const a=data.tokenMintA.toBase58(),b=data.tokenMintB.toBase58();
  if(!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))throw new Error('Unexpected Whirlpool token mints');
  const inputMint=direction==='USDC_TO_SOL'?USDC_MINT:SOL_MINT;
  const result=await swapQuoteByInputToken(pool,new PublicKey(inputMint),new BN(inputRaw.toString()),
   Percentage.fromFraction(0,10000),this.ctx.program.programId,this.client.getFetcher(),IGNORE_CACHE);
  if(result.estimatedAmountOut.isNeg()||result.estimatedAmountOut.isZero())throw new Error('No executable amount-out in Whirlpool quote');
  return {pool:poolAddress,direction,inputRaw:inputRaw.toString(),outputRaw:result.estimatedAmountOut.toString(),
   feeRaw:result.estimatedFeeAmount.toString(),observedAt:new Date().toISOString(),
   poolSlot:account.context.slot,classification:'indicative_non_executable'};
 }
 async scanOnce(){
  if(this.busy)return;this.busy=true;
  this.state={...this.state,status:'scanning'};
  const orca=this.pools.filter(p=>p.venue==='orca'&&p.owner===ORCA_WHIRLPOOL);
  const legs:OrcaQuote[]=[],candidates:ArbitrageCandidate[]=[],errors:string[]=[];
  try{
   const rayQuotes=this.getRaydiumQuotes();
   const bySize=new Map<number,AmmV4Quote[]>();
   for(const q of rayQuotes){const size=Number(BigInt(q.inputRaw))/1e6;bySize.set(size,[...(bySize.get(size)??[]),q]);}
   for(const pool of orca){
    for(const size of this.sizesUsd){
     const amount=BigInt(Math.round(size*1e6));
     try{
      const buy=await this.quote(pool.address,'USDC_TO_SOL',amount);legs.push(buy);
      // Buy Orca, sell Raydium using each known Raydium pool's USDC-side output reserve.
      for(const ray of bySize.get(size)??[]){
       try{
        const solIn=BigInt(buy.outputRaw),feeNum=BigInt(ray.feeNumerator),feeDen=BigInt(ray.feeDenominator);
        const output=amountOutExactInput(solIn,BigInt(ray.reserveOutRaw),BigInt(ray.reserveInRaw),feeNum,feeDen);
        const candidate=evaluateRoute(size,{pool:pool.address,venue:'orca',inputRaw:buy.inputRaw,outputRaw:buy.outputRaw,observedAt:buy.observedAt},
         {pool:ray.pool,venue:'raydium',inputRaw:buy.outputRaw,outputRaw:output.toString(),observedAt:ray.observedAt},this.assumedCostUsd);
        candidates.push(candidate);
       }catch(e){errors.push(`Orca->Raydium ${pool.address}/${ray.pool}: ${String(e)}`);}
      }
      // Buy Raydium, sell Orca at EXACT amount produced by first leg.
      for(const ray of bySize.get(size)??[]){
       try{
        const sell=await this.quote(pool.address,'SOL_TO_USDC',BigInt(ray.outputRaw));legs.push(sell);
        candidates.push(evaluateRoute(size,
         {pool:ray.pool,venue:'raydium',inputRaw:ray.inputRaw,outputRaw:ray.outputRaw,observedAt:ray.observedAt},
         {pool:pool.address,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt},
         this.assumedCostUsd));
       }catch(e){errors.push(`Raydium->Orca ${ray.pool}/${pool.address}: ${String(e)}`);}
      }
     }catch(e){errors.push(`${pool.address} $${size}: ${String(e)}`);}
    }
   }
  }finally{
   this.busy=false;
   this.state={status:errors.length?'partial_error':'ok',lastUpdatedAt:new Date().toISOString(),
    quotedLegs:legs,routeCandidates:candidates,errors,orcaPools:orca.length};
  }
 }
 start(){if(this.running)return;this.running=true;const loop=async()=>{if(!this.running)return;try{await this.scanOnce();}catch(e){this.state={...this.state,status:'partial_error',errors:[String(e)]};}if(this.running)this.timer=setTimeout(()=>{void loop();},this.intervalMs);};void loop();}
 stop(){this.running=false;if(this.timer)clearTimeout(this.timer);}
}
