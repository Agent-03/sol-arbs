import type {DiscoveredPool} from './discovery.js';
import {identifyProgram,RAYDIUM_CLMM,type VenueProgram} from './routes.js';
import type {LiveRaydiumSnapshot} from './liveRaydium.js';
import type {OrcaStatus} from './orca.js';
import type {ClmmHealth} from './clmm.js';

export type PoolEligibility={
 address:string;venue:DiscoveredPool['venue'];program:VenueProgram;liquidityUsd?:number;
 state:'active'|'refreshing'|'expired'|'waiting'|'excluded'|'unsupported'|'not_selected';
 reason:string;qualifiesForResearch:boolean;
 lastObservedAt?:string;poolAgeMs?:number;tickAgeMs?:number;
 tickSlotVerified:boolean;quoteLegs:number;
};
export function classifyPoolEligibility(
 pools:readonly DiscoveredPool[],
 ray:LiveRaydiumSnapshot,
 orca:OrcaStatus,
 clmm:ClmmHealth,
 minLiquidityUsd:number,
 maxClmmPools:number,
 maxQuoteAgeMs:number,
 now=Date.now()
):PoolEligibility[]{
 const eligibleClmm=pools.filter(p=>p.owner===RAYDIUM_CLMM&&
   (p.venue==='raydium'||p.venue==='manual')&&
   (p.liquidityUsd===undefined||p.liquidityUsd>=minLiquidityUsd))
   .sort((a,b)=>(b.liquidityUsd??0)-(a.liquidityUsd??0))
   .slice(0,maxClmmPools);
 const chosenClmm=new Set(eligibleClmm.map(p=>p.address));
 return pools.map(pool=>{
  const program=identifyProgram(pool.owner);
  const base={address:pool.address,venue:pool.venue,program,liquidityUsd:pool.liquidityUsd,
   tickSlotVerified:false,quoteLegs:0};
  const record=(state:PoolEligibility['state'],reason:string,qualifiesForResearch=false,
   meta:Partial<PoolEligibility>={}):PoolEligibility=>({...base,state,reason,qualifiesForResearch,...meta});
  if(program==='unsupported')return record('unsupported','Unsupported on-chain DEX program');
  if(program==='orca_whirlpool'&&pool.venue==='raydium'||
     (program==='raydium_amm_v4'||program==='raydium_clmm')&&pool.venue==='orca')
   return record('unsupported','Discovery venue does not match program owner');
  if(pool.liquidityUsd===undefined)return record('excluded','Reported pool liquidity unavailable: not comparable');
  if(pool.liquidityUsd<minLiquidityUsd)return record('excluded','Reported liquidity below $'+minLiquidityUsd.toLocaleString());
  if(program==='raydium_amm_v4'){
   const q=ray.quotes.filter(x=>x.pool===pool.address);
   const reason=ray.poolReasons[pool.address];
   if(reason)return record('waiting',reason);
   if(!q.length)return record('waiting','Awaiting verified pool and vault state');
   const at=q[0].observedAt;
   const ageMs=Math.max(0,now-Date.parse(at));
   if(ageMs>maxQuoteAgeMs)return record('expired','AMM v4 observation outside comparison freshness window',false,
    {quoteLegs:q.length,lastObservedAt:at,poolAgeMs:ageMs});
   return record('active','AMM v4 state available; OpenBook orders not reconciled',true,
    {quoteLegs:q.length,lastObservedAt:at,poolAgeMs:ageMs});
  }
  if(program==='raydium_clmm'){
   if(!chosenClmm.has(pool.address))return record('not_selected','Outside current CLMM RPC quote budget');
   const p=clmm.perPool.find(q=>q.pool===pool.address);
   if(!p||p.status==='missing')return record('waiting',p?.reason??'Waiting for Raydium SDK tick-array snapshot');
   const ageMs=p.ageMs;
   const meta={lastObservedAt:p.lastObservedAt,poolAgeMs:ageMs,tickAgeMs:ageMs,
    tickSlotVerified:p.tickArraySlotVerified??false,
    quoteLegs:clmm.quotes.filter(q=>q.pool===pool.address).length};
   if(p.status==='refreshing')return record('refreshing','Refreshing Raydium CLMM tick-array SDK snapshot',false,meta);
   if(p.status==='expired'||(ageMs!==undefined&&ageMs>maxQuoteAgeMs))
    return record('expired',p.reason??'CLMM local dependencies are old, missing or slot-inconsistent',false,meta);
   if(!meta.quoteLegs)return record('waiting','CLMM tick arrays fetched but SDK could not produce a valid swap quote',false,meta);
   return record('active',meta.tickSlotVerified?'CLMM pool, tick arrays, fee config and bitmap within bounded slot skew; still indicative':'SDK CLMM quote from independent RPC snapshots; tick slots unverified',true,meta);
  }
  if(program==='orca_whirlpool'){
   const legs=orca.quotedLegs.filter(q=>q.pool===pool.address);
   const poolFresh=orca.poolFreshness?.find(p=>p.pool===pool.address);
   const latest=legs.slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
   const ageMs=latest?Math.max(0,now-Date.parse(latest.observedAt)):undefined;
   const latestTick=Date.parse(latest?.tickArraysObservedAt??'');
   const meta:Partial<PoolEligibility>={quoteLegs:legs.length,lastObservedAt:latest?.observedAt,
    poolAgeMs:ageMs,tickAgeMs:Number.isFinite(latestTick)?Math.max(0,now-latestTick):undefined,
    tickSlotVerified:latest?.tickArraySlot!=null};
   if(orca.invalidatedPools?.includes(pool.address))
    return record('expired','Newer pool/tick state invalidated the last-known Orca quote; exact-input swap not currently available',false,meta);
   if(poolFresh?.refreshing)return record('refreshing','Refreshing Orca SDK data; previous quotes retained',false,meta);
   if(!legs.length)return record('waiting','Awaiting first valid Whirlpool/tick-array quote',false,meta);
   if(ageMs!==undefined&&ageMs>maxQuoteAgeMs)return record('expired','Last Whirlpool quote is older than the comparison threshold',false,meta);
   return record('active',meta.tickSlotVerified?'Whirlpool SDK local quote from bounded pool/tick slot state':'Whirlpool RPC SDK quote; tick-array slots unverified',true,meta);
  }
  return record('unsupported','No quote adapter');
 });
}

export type CoverageSummary={
 discoveredPools:number;supportedEligiblePools:number;activeQuotePools:number;
 poolsWaiting:number;poolsRefreshing:number;poolsExpired:number;
 lowLiquidityOrUnsupported:number;raydiumPairs:number;orcaPools:number;
 sizes:number;theoreticalComparisons:number;completeEstimates:number;
 freshnessQualified:number;positiveEstimates:number;negativeEstimates:number;
 comparisonCoveragePct:number;
};
export function computeCoverage(
 rows:readonly PoolEligibility[],sizes:number,
 completeEstimates:number,freshnessQualified:number,
 positiveEstimates:number,negativeEstimates:number,
 monitoredDirections:1|2=2
):CoverageSummary{
 const supported=rows.filter(r=>r.program!=='unsupported'&&r.state!=='excluded'&&r.state!=='not_selected');
 const ray=supported.filter(p=>p.program==='raydium_amm_v4'||p.program==='raydium_clmm');
 const orca=supported.filter(p=>p.program==='orca_whirlpool');
 const theoretical=ray.length*orca.length*sizes*monitoredDirections;
 return {discoveredPools:rows.length,supportedEligiblePools:supported.length,
  activeQuotePools:rows.filter(r=>r.state==='active').length,
  poolsWaiting:rows.filter(r=>r.state==='waiting').length,
  poolsRefreshing:rows.filter(r=>r.state==='refreshing').length,
  poolsExpired:rows.filter(r=>r.state==='expired').length,
  lowLiquidityOrUnsupported:rows.filter(r=>r.state==='excluded'||r.state==='unsupported'||r.state==='not_selected').length,
  raydiumPairs:ray.length,orcaPools:orca.length,sizes,
  theoreticalComparisons:theoretical,completeEstimates,
  freshnessQualified,positiveEstimates,negativeEstimates,
  comparisonCoveragePct:theoretical?Math.min(100,100*freshnessQualified/theoretical):0};
}
