import {amountOutExactInput,type AmmV4Quote} from './ammV4.js';
import {evaluateRoute,type ArbitrageCandidate,type OrcaQuote} from './orca.js';
import type {ClmmQuote} from './clmm.js';

export type LiveCombination={
 candidates:ArbitrageCandidate[];
 unmatchedReverseLegs:number;
 failed:number;
 evaluated:number;
 clmmEvaluated:number;
};

export function combineLiveQuotes(
 raydium:readonly AmmV4Quote[],
 orca:readonly OrcaQuote[],
 assumedCostUsd:number,
 poolLiquidity:ReadonlyMap<string,number|undefined>,
 clmmBuys:readonly ClmmQuote[]=[],
 quoteClmmSell?:(pool:string,amountRaw:bigint)=>ClmmQuote|null
):LiveCombination{
 const candidates:ArbitrageCandidate[]=[];
 let unmatchedReverseLegs=0,failed=0,evaluated=0,clmmEvaluated=0;
 const rays=raydium.filter(r=>r.direction==='USDC_TO_SOL');
 const buys=orca.filter(o=>o.direction==='USDC_TO_SOL'&&!o.invalidated);
 const sells=orca.filter(o=>o.direction==='SOL_TO_USDC'&&!o.invalidated);
 const orcaPoolCount=new Set(orca.filter(q=>!q.invalidated).map(q=>q.pool)).size;
 const emit=(candidate:ArbitrageCandidate,model:'amm_v4'|'clmm')=>{
  candidates.push({...candidate,raydiumModel:model,
   buyLiquidityUsd:poolLiquidity.get(candidate.buyPool),
   sellLiquidityUsd:poolLiquidity.get(candidate.sellPool)});
 };
 for(const ray of rays){
  const size=Number(BigInt(ray.inputRaw))/1e6;
  for(const buy of buys){
   if(buy.inputRaw!==ray.inputRaw||buy.pool===ray.pool)continue;
   evaluated++;
   try{
    const output=amountOutExactInput(
     BigInt(buy.outputRaw),BigInt(ray.reserveOutRaw),BigInt(ray.reserveInRaw),
     BigInt(ray.feeNumerator),BigInt(ray.feeDenominator)
    );
    const result=evaluateRoute(size,
     {pool:buy.pool,venue:'orca',inputRaw:buy.inputRaw,outputRaw:buy.outputRaw,observedAt:buy.observedAt,slot:buy.poolSlot},
     {pool:ray.pool,venue:'raydium',inputRaw:buy.outputRaw,outputRaw:output.toString(),observedAt:ray.observedAt,slot:ray.vaultSlot},
     assumedCostUsd);
    emit(result,'amm_v4');
   }catch{failed++;}
  }
  const matching=sells.filter(s=>s.inputRaw===ray.outputRaw&&s.pool!==ray.pool);
  unmatchedReverseLegs+=Math.max(0,orcaPoolCount-matching.length);
  for(const sell of matching){
   evaluated++;
   try{
    const result=evaluateRoute(size,
     {pool:ray.pool,venue:'raydium',inputRaw:ray.inputRaw,outputRaw:ray.outputRaw,observedAt:ray.observedAt,slot:ray.vaultSlot},
     {pool:sell.pool,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},
     assumedCostUsd);
    emit(result,'amm_v4');
   }catch{failed++;}
  }
 }
 // CLMM cross-venue: use Raydium's SDK tick-array-aware local math for
 // Orca -> CLMM exact-input second legs. No additional RPC on this hot path.
 if(quoteClmmSell){
  const clmmPools=[...new Set(clmmBuys.map(q=>q.pool))];
  for(const buy of buys)for(const pool of clmmPools){
   evaluated++;clmmEvaluated++;
   try{
    const sellQuote=quoteClmmSell(pool,BigInt(buy.outputRaw));
    if(!sellQuote||sellQuote.outputRaw==='0'){failed++;continue;}
    const size=Number(BigInt(buy.inputRaw))/1e6;
    const result=evaluateRoute(size,
     {pool:buy.pool,venue:'orca',inputRaw:buy.inputRaw,outputRaw:buy.outputRaw,observedAt:buy.observedAt,slot:buy.poolSlot},
     {pool,venue:'raydium',inputRaw:buy.outputRaw,outputRaw:sellQuote.outputRaw,observedAt:sellQuote.observedAt,slot:sellQuote.poolSlot},
     assumedCostUsd);
    emit(result,'clmm');
   }catch{failed++;}
  }
 }
 // CLMM -> Orca: exact SOL amount from SDK must match Orca reverse input.
 // A new Raydium quote never makes a cached reverse amount valid by itself.
 for(const clmm of clmmBuys){
  const size=Number(BigInt(clmm.inputRaw))/1e6;
  const matches=sells.filter(s=>s.inputRaw===clmm.outputRaw&&s.pool!==clmm.pool);
  unmatchedReverseLegs+=Math.max(0,orcaPoolCount-matches.length);
  for(const sell of matches){
   evaluated++;clmmEvaluated++;
   try{
    const result=evaluateRoute(size,
     {pool:clmm.pool,venue:'raydium',inputRaw:clmm.inputRaw,outputRaw:clmm.outputRaw,observedAt:clmm.observedAt,slot:clmm.poolSlot},
     {pool:sell.pool,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},
     assumedCostUsd);
    emit(result,'clmm');
   }catch{failed++;}
  }
 }
 return {candidates,unmatchedReverseLegs,failed,evaluated,clmmEvaluated};
}
