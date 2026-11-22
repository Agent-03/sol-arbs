import type {ArbitrageCandidate} from './orca.js';

export type FreshnessRules={maxAgeMs:number;maxGapMs:number;maxSlotSkew:number;minLiquidityUsd?:number};
export type AssessedRoute=ArbitrageCandidate&{
  freshness:'aligned'|'stale';
  eligibleForComparison:boolean;
  quoteAgeMs:number;
  buyAgeMs:number;
  sellAgeMs:number;
  slotGap:number|null;
  freshnessReasons:string[];
};
export type RouteSummary={
  total:number;comparable:number;excluded:number;positiveComparable:number;
  negativeComparable:number;bestComparableNetUsd:number|null;
  bestRawNetUsd:number|null;bestComparable?:AssessedRoute;
  excludedByReason:Record<string,number>;
  candidates:AssessedRoute[];
  comparableCandidates:AssessedRoute[];
  excludedCandidates:AssessedRoute[];
};
/**
 * "Aligned" means sufficiently close observations for *research comparison*.
 * It does not mean same-slot, atomic, transaction-simulated, or executable.
 * A route that fails these checks is excluded from opportunity rankings.
 */
export function assessRoutes(
 candidates:readonly ArbitrageCandidate[],
 rules:FreshnessRules,
 now=Date.now()
):RouteSummary{
 if(!Number.isFinite(now)||
    [rules.maxAgeMs,rules.maxGapMs,rules.maxSlotSkew].some(x=>!Number.isSafeInteger(x)||x<0)||
    (rules.minLiquidityUsd!==undefined&&(!Number.isFinite(rules.minLiquidityUsd)||rules.minLiquidityUsd<0)))
   throw new Error('Invalid assessment timestamp or freshness rules');
 const assessed:AssessedRoute[]=candidates.map(candidate=>{
  const a=Date.parse(candidate.buyObservedAt);
  const b=Date.parse(candidate.sellObservedAt);
  const buyAgeMs=Number.isFinite(a)?Math.max(0,now-a):Number.POSITIVE_INFINITY;
  const sellAgeMs=Number.isFinite(b)?Math.max(0,now-b):Number.POSITIVE_INFINITY;
  const quoteAgeMs=Math.max(buyAgeMs,sellAgeMs);
  const gap=Math.abs(a-b);
  const buySlot=candidate.buySlot;
  const sellSlot=candidate.sellSlot;
  const slotGap=buySlot!=null&&sellSlot!=null?Math.abs(buySlot-sellSlot):null;
  const freshnessReasons:string[]=[];
  if(!Number.isFinite(a)||!Number.isFinite(b)||a>now+1000||b>now+1000)freshnessReasons.push('invalid_observation_time');
  if(quoteAgeMs>rules.maxAgeMs)freshnessReasons.push('quote_age_exceeded');
  if(!Number.isFinite(gap)||gap>rules.maxGapMs)freshnessReasons.push('quote_gap_exceeded');
  if(rules.minLiquidityUsd && (
   candidate.buyLiquidityUsd===undefined || candidate.sellLiquidityUsd===undefined
  ))freshnessReasons.push('unknown_pool_liquidity');
  else if(rules.minLiquidityUsd && (
   (candidate.buyLiquidityUsd ?? 0) < rules.minLiquidityUsd || (candidate.sellLiquidityUsd ?? 0) < rules.minLiquidityUsd
  ))freshnessReasons.push('insufficient_pool_liquidity');
  if(slotGap===null)freshnessReasons.push('missing_pool_slot');
  else if(slotGap>rules.maxSlotSkew)freshnessReasons.push('pool_slot_skew_exceeded');
  return {...candidate,quoteAgeMs,buyAgeMs,sellAgeMs,slotGap,
   freshness:freshnessReasons.length?'stale':'aligned',
   eligibleForComparison:freshnessReasons.length===0,
   freshnessReasons};
 });
 const byNet=(a:AssessedRoute,b:AssessedRoute)=>b.indicativeNetUsd-a.indicativeNetUsd;
 const comparableCandidates=assessed.filter(x=>x.eligibleForComparison).sort(byNet);
 const excludedCandidates=assessed.filter(x=>!x.eligibleForComparison).sort(byNet);
 const excludedByReason:Record<string,number>={};
 for(const c of excludedCandidates)for(const reason of c.freshnessReasons)
   excludedByReason[reason]=(excludedByReason[reason]??0)+1;
 const comparable=comparableCandidates.length;
 const bestComparable=comparableCandidates[0];
 return {
  total:assessed.length,comparable,excluded:excludedCandidates.length,
  positiveComparable:comparableCandidates.filter(x=>x.indicativeNetUsd>0).length,
  negativeComparable:comparableCandidates.filter(x=>x.indicativeNetUsd<=0).length,
  bestComparableNetUsd:bestComparable?.indicativeNetUsd??null,
  bestRawNetUsd:assessed.length?Math.max(...assessed.map(x=>x.indicativeNetUsd)):null,
  bestComparable,excludedByReason,
  candidates:[...comparableCandidates,...excludedCandidates],
  comparableCandidates,excludedCandidates
 };
}
