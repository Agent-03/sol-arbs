import {amountOutExactInput,type AmmV4Quote} from './ammV4.js';
import {evaluateRoute,type ArbitrageCandidate,type OrcaQuote} from './orca.js';

export type LiveCombination={
 candidates:ArbitrageCandidate[];
 unmatchedReverseLegs:number;
 failed:number;
 evaluated:number;
};
export type LiveEvaluationEvent={
 pool:string;
 slot:number;
 observedAt:string;
 receivedAtMs:number;
 source:'websocket'|'reconcile'|'bootstrap';
};
/**
 * Pure, synchronous recomputation. No RPC calls, clock reads, or state
 * mutation. Quotes remain indicative even when two observed slots are close.
 *
 * The Orca->Raydium leg is recomputed from the latest Raydium reserve state
 * at the EXACT SOL amount returned by the cached Orca buy quote.
 * Raydium->Orca is included only when Orca's cached reverse quote matches
 * the exact current Raydium first-leg output. Never reuse a mismatched input.
 */
export function combineLiveQuotes(
 raydium:readonly AmmV4Quote[],
 orca:readonly OrcaQuote[],
 assumedCostUsd:number,
 poolLiquidity:ReadonlyMap<string,number|undefined>
):LiveCombination {
 const candidates:ArbitrageCandidate[]=[];
 let unmatchedReverseLegs=0,failed=0,evaluated=0;
 const rays=raydium.filter(r=>r.direction==='USDC_TO_SOL');
 const buys=orca.filter(o=>o.direction==='USDC_TO_SOL');
 const sells=orca.filter(o=>o.direction==='SOL_TO_USDC');
 for(const ray of rays){
  const size=Number(BigInt(ray.inputRaw))/1e6;
  for(const buy of buys){
   if(buy.inputRaw!==ray.inputRaw||buy.pool===ray.pool)continue;
   evaluated++;
   try{
    const output=amountOutExactInput(
     BigInt(buy.outputRaw),BigInt(ray.reserveOutRaw),
     BigInt(ray.reserveInRaw),BigInt(ray.feeNumerator),BigInt(ray.feeDenominator)
    );
    const result=evaluateRoute(size,
     {pool:buy.pool,venue:'orca',inputRaw:buy.inputRaw,outputRaw:buy.outputRaw,observedAt:buy.observedAt,slot:buy.poolSlot},
     {pool:ray.pool,venue:'raydium',inputRaw:buy.outputRaw,outputRaw:output.toString(),observedAt:ray.observedAt,slot:ray.vaultSlot},
     assumedCostUsd);
    candidates.push({...result,buyLiquidityUsd:poolLiquidity.get(buy.pool),sellLiquidityUsd:poolLiquidity.get(ray.pool)});
   }catch{failed++;}
  }
  const matching=sells.filter(s=>s.inputRaw===ray.outputRaw&&s.pool!==ray.pool);
  unmatchedReverseLegs+=sells.filter(s=>s.pool!==ray.pool&&s.inputRaw!==ray.outputRaw).length;
  for(const sell of matching){
   evaluated++;
   try{
    const result=evaluateRoute(size,
     {pool:ray.pool,venue:'raydium',inputRaw:ray.inputRaw,outputRaw:ray.outputRaw,observedAt:ray.observedAt,slot:ray.vaultSlot},
     {pool:sell.pool,venue:'orca',inputRaw:sell.inputRaw,outputRaw:sell.outputRaw,observedAt:sell.observedAt,slot:sell.poolSlot},
     assumedCostUsd);
    candidates.push({...result,buyLiquidityUsd:poolLiquidity.get(ray.pool),sellLiquidityUsd:poolLiquidity.get(sell.pool)});
   }catch{failed++;}
  }
 }
 return {candidates,unmatchedReverseLegs,failed,evaluated};
}
