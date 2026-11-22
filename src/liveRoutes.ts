import {amountOutExactInput,type AmmV4Quote} from './ammV4.js';
import {evaluateRoute,type ArbitrageCandidate,type OrcaQuote} from './orca.js';
import type {ClmmQuote} from './clmm.js';

export type LiveCombination={
 candidates:ArbitrageCandidate[];
 unmatchedReverseLegs:number;
 failed:number;
 evaluated:number;
 clmmEvaluated:number;
 localReverseHits:number;
 localReverseMisses:number;
};

/** Exact-output chaining for every distinct-pool two-leg combination.
 * All computations are local. Same-venue pools are valid independent
 * liquidity sources, but remain indicative and non-executable.
 * Optional Orca reverse adapter MUST compute at the exact first-leg SOL
 * output; using a fixed-size reverse quote would fabricate opportunities.
 */
export function combineLiveQuotes(
 raydium:readonly AmmV4Quote[],
 orca:readonly OrcaQuote[],
 assumedCostUsd:number,
 poolLiquidity:ReadonlyMap<string,number|undefined>,
 clmmBuys:readonly ClmmQuote[]=[],
 quoteClmmSell?:(pool:string,amountRaw:bigint)=>ClmmQuote|null,
 quoteOrcaSell?:(pool:string,amountRaw:bigint)=>OrcaQuote|null,
 orcaSellPools?:readonly string[]
):LiveCombination{
 const candidates:ArbitrageCandidate[]=[];
 let unmatchedReverseLegs=0,failed=0,evaluated=0,clmmEvaluated=0;
 let localReverseHits=0,localReverseMisses=0;
 const rays=raydium.filter(q=>q.direction==='USDC_TO_SOL');
 const orcaBuys=orca.filter(q=>q.direction==='USDC_TO_SOL'&&!q.invalidated);
 const existingSells=orca.filter(q=>q.direction==='SOL_TO_USDC'&&!q.invalidated);
 const orcaPools=[...new Set(orcaSellPools??orca.filter(q=>!q.invalidated).map(q=>q.pool))];
 const clmmPools=[...new Set(clmmBuys.map(q=>q.pool))];
 type Buy={pool:string;venue:'raydium'|'orca';model:'amm_v4'|'clmm'|'orca';
  inputRaw:string;outputRaw:string;observedAt:string;slot:number|null};
 const buys:Buy[]=[
  ...rays.map(q=>({pool:q.pool,venue:'raydium' as const,model:'amm_v4' as const,
   inputRaw:q.inputRaw,outputRaw:q.outputRaw,observedAt:q.observedAt,slot:q.vaultSlot})),
  ...orcaBuys.map(q=>({pool:q.pool,venue:'orca' as const,model:'orca' as const,
   inputRaw:q.inputRaw,outputRaw:q.outputRaw,observedAt:q.observedAt,slot:q.poolSlot})),
  ...clmmBuys.map(q=>({pool:q.pool,venue:'raydium' as const,model:'clmm' as const,
   inputRaw:q.inputRaw,outputRaw:q.outputRaw,observedAt:q.observedAt,slot:q.poolSlot}))
 ];
 const emit=(buy:Buy,sell:{pool:string;venue:'raydium'|'orca';
  inputRaw:string;outputRaw:string;observedAt:string;slot:number|null},
  model:'amm_v4'|'clmm'|'orca')=>{
  const size=Number(BigInt(buy.inputRaw))/1e6;
  const route=evaluateRoute(size,
   {pool:buy.pool,venue:buy.venue,inputRaw:buy.inputRaw,
    outputRaw:buy.outputRaw,observedAt:buy.observedAt,slot:buy.slot},
   sell,assumedCostUsd);
  candidates.push({...route,raydiumModel:buy.model==='clmm'||model==='clmm'?'clmm':'amm_v4',
   buyLiquidityUsd:poolLiquidity.get(buy.pool),
   sellLiquidityUsd:poolLiquidity.get(sell.pool)});
 };
 for(const buy of buys){
  // Match exact USDC input sizes; do not interpolate a different trade size.
  for(const ray of rays){
   if(buy.pool===ray.pool||buy.inputRaw!==ray.inputRaw)continue;
   evaluated++;
   if(buy.model==='clmm')clmmEvaluated++;
   try{
    const amount=amountOutExactInput(BigInt(buy.outputRaw),
     BigInt(ray.reserveOutRaw),BigInt(ray.reserveInRaw),
     BigInt(ray.feeNumerator),BigInt(ray.feeDenominator));
    emit(buy,{pool:ray.pool,venue:'raydium',inputRaw:buy.outputRaw,
     outputRaw:amount.toString(),observedAt:ray.observedAt,slot:ray.vaultSlot},'amm_v4');
   }catch{failed++}
  }
  // Exact-input Orca reverse at the output of ANY first leg. Cached reverse
  // values are used only when raw inputs match; otherwise local SDK math runs.
  for(const pool of orcaPools){
   if(buy.pool===pool)continue;
   let sell=existingSells.find(q=>q.pool===pool&&q.inputRaw===buy.outputRaw);
   if(!sell&&quoteOrcaSell){
    try{
     const quoted=quoteOrcaSell(pool,BigInt(buy.outputRaw));
     if(quoted&&quoted.pool===pool&&quoted.direction==='SOL_TO_USDC'&&
       quoted.inputRaw===buy.outputRaw&&!quoted.invalidated){
      sell=quoted;localReverseHits++;
     }else localReverseMisses++;
    }catch{localReverseMisses++}
   }
   if(!sell){unmatchedReverseLegs++;continue;}
   evaluated++;
   if(buy.model==='clmm')clmmEvaluated++;
   try{
    emit(buy,{pool:sell.pool,venue:'orca',inputRaw:sell.inputRaw,
     outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},'orca');
   }catch{failed++}
  }
  // Raydium CLMM output depends on tick traversal. Never invent second-leg
  // output if there is no ready, exact-input local SDK calculation.
  if(quoteClmmSell)for(const pool of clmmPools){
   if(buy.pool===pool)continue;
   evaluated++;clmmEvaluated++;
   try{
    const q=quoteClmmSell(pool,BigInt(buy.outputRaw));
    if(!q||q.direction!=='SOL_TO_USDC'||q.inputRaw!==buy.outputRaw||
     q.pool!==pool||BigInt(q.outputRaw)<=0n){failed++;continue;}
    emit(buy,{pool,venue:'raydium',inputRaw:q.inputRaw,
     outputRaw:q.outputRaw,observedAt:q.observedAt,slot:q.poolSlot},'clmm');
   }catch{failed++}
  }
 }
 return {candidates,unmatchedReverseLegs,failed,evaluated,clmmEvaluated,
  localReverseHits,localReverseMisses};
}
