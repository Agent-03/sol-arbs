import {amountOutExactInput} from './ammV4.js';
import {SOL_MINT,USDC_MINT} from './discovery.js';

export type GraphAsset='USDC'|'SOL'|'USDT'|'JUP';
export const GRAPH_ASSETS:Readonly<Record<GraphAsset,{mint:string;decimals:number}>>={
 USDC:{mint:USDC_MINT,decimals:6},
 SOL:{mint:SOL_MINT,decimals:9},
 USDT:{mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',decimals:6},
 JUP:{mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',decimals:6}
};
const MINT_TO_ASSET=new Map(Object.entries(GRAPH_ASSETS).map(([name,token])=>[token.mint,name as GraphAsset]));
export const assetOfMint=(mint:string):GraphAsset|undefined=>MINT_TO_ASSET.get(mint);

export type GraphPool={
 address:string;program:'raydium_amm_v4';tokenA:GraphAsset;tokenB:GraphAsset;
 reserveA:string;reserveB:string;feeNumerator:string;feeDenominator:string;
 observedAt:string;poolSlot:number;vaultSlot:number;liquidityUsd:number|null;
 // Exact-byte coherence across all 3 accounts is not established by 12-slot tolerance.
 snapshotIntegrity:'bounded_slot_research';
};
export type GraphLeg={
 pool:string;program:GraphPool['program'];
 from:GraphAsset;to:GraphAsset;amountInRaw:string;amountOutRaw:string;
 poolSlot:number;vaultSlot:number;observedAt:string;liquidityUsd:number|null;
};
export type GraphCycle={
 id:string;legs:2|3;tokenPath:GraphAsset[];poolPath:string[];
 sizeUsd:number;inputUsdcRaw:string;outputUsdcRaw:string;
 grossUsd:number;assumedCostUsd:number;indicativeNetUsd:number;
 minObservedAt:string;maxObservedAt:string;maxSlotGap:number;
 hops:GraphLeg[];classification:'indicative_only';executable:false;
 caveats:string[];
};
export type GraphScanLimits={
 sizesUsd:readonly number[];maxAgeMs:number;maxGapMs:number;maxSlotSkew:number;
 minLiquidityUsd:number;maxPathChecks:number;maxResults:number;assumedCostUsd:number;
};
export type GraphEvaluation={
 phase:'C3B';mode:'READ_ONLY';evaluatedAt:string;
 elapsedMs:number;poolCount:number;eligiblePools:number;stalePools:number;
 pathChecks:number;truncated:boolean;
 twoLegChecks:number;threeLegChecks:number;
 twoLegCycles:number;threeLegCycles:number;positiveIndicative:number;
 bestIndicativeNetUsd:number|null;candidates:GraphCycle[];
 limitations:string[];
};
const LIMITATIONS=[
 'Raydium AMM V4 pool-vault local CPMM math only; no Orca/CLMM/Meteora quotes in this C3 graph.',
 'Independent WebSocket account observations are not same-slot atomic snapshots.',
 'Fees, Jito tips and execution landing are estimates or unknown; a positive route is not executable profit.',
 'Historical replay, transaction simulation and actual swap execution are NOT enabled.'
];
type Edge={pool:GraphPool;from:GraphAsset;to:GraphAsset;reserveIn:bigint;reserveOut:bigint;feeNum:bigint;feeDen:bigint};
const validInt=(n:number)=>Number.isSafeInteger(n)&&n>=0;

/** Pure synchronous graph enumeration. No RPC, WebSockets or async price calls.
 * Each path applies the next pool's exact-input integer CPMM quote to the
 * preceding pool's raw token output. No mid-price multiplication or extrapolation.
 */
export function evaluateGraphCycles(pools:readonly GraphPool[],limits:GraphScanLimits,now=Date.now()):GraphEvaluation{
 if(!Number.isFinite(now)||!limits.sizesUsd.length||limits.sizesUsd.length>12||
  limits.sizesUsd.some(x=>!Number.isFinite(x)||x<=0||x>1_000_000)||
  !validInt(limits.maxAgeMs)||!validInt(limits.maxGapMs)||
  !validInt(limits.maxSlotSkew)||!validInt(limits.maxPathChecks)||
  limits.maxPathChecks<1||!validInt(limits.maxResults)||limits.maxResults<1||
  !Number.isFinite(limits.minLiquidityUsd)||limits.minLiquidityUsd<0||
  !Number.isFinite(limits.assumedCostUsd)||limits.assumedCostUsd<0)
  throw new Error('Invalid C3B graph scan limits');
 const started=Date.now();
 const edges=new Map<GraphAsset,Edge[]>();
 const unique=new Set<string>();
 let eligiblePools=0,stalePools=0;
 for(const pool of pools){
  if(unique.has(pool.address))continue;
  unique.add(pool.address);
  const at=Date.parse(pool.observedAt);
  if(!Number.isFinite(at)||at>now+1000||now-at>limits.maxAgeMs||
   pool.tokenA===pool.tokenB||
   Math.abs(pool.poolSlot-pool.vaultSlot)>limits.maxSlotSkew||
   (pool.liquidityUsd!==null&&pool.liquidityUsd<limits.minLiquidityUsd)||
   (pool.liquidityUsd===null&&limits.minLiquidityUsd>0)){
   stalePools++;continue;
  }
  try{
   const ra=BigInt(pool.reserveA),rb=BigInt(pool.reserveB);
   const fn=BigInt(pool.feeNumerator),fd=BigInt(pool.feeDenominator);
   if(ra<=0n||rb<=0n||fn<0n||fd<=0n||fn>=fd)throw new Error('invalid reserves');
   const a:Edge={pool,from:pool.tokenA,to:pool.tokenB,reserveIn:ra,reserveOut:rb,feeNum:fn,feeDen:fd};
   const b:Edge={...a,from:pool.tokenB,to:pool.tokenA,reserveIn:rb,reserveOut:ra};
   edges.set(a.from,[...(edges.get(a.from)??[]),a]);
   edges.set(b.from,[...(edges.get(b.from)??[]),b]);
   eligiblePools++;
  }catch{stalePools++}
 }
 let pathChecks=0,twoLegChecks=0,threeLegChecks=0;
 let twoLegCycles=0,threeLegCycles=0,positiveIndicative=0;
 let truncated=false;
 const candidates:GraphCycle[]=[];
 const seen=new Set<string>();
 const recurse=(asset:GraphAsset,raw:bigint,depth:number,path:GraphLeg[],
  usedPools:Set<string>,visitedMints:Set<GraphAsset>,sizeUsd:number):void=>{
  if(truncated)return;
  if(depth>=3)return;
  for(const edge of edges.get(asset)??[]){
   if(truncated)return;
   if(usedPools.has(edge.pool.address))continue;
   const last=edge.to==='USDC';
   if(last&&depth<1)continue;
   if(!last&&visitedMints.has(edge.to))continue;
   if(!last&&depth>=2)continue;
   if(pathChecks>=limits.maxPathChecks){truncated=true;return;}
   pathChecks++;
   const n=depth+1;
   if(n===2)twoLegChecks++;
   if(n===3)threeLegChecks++;
   let output:bigint;
   try{output=amountOutExactInput(raw,edge.reserveIn,edge.reserveOut,edge.feeNum,edge.feeDen);}
   catch{continue}
   if(output<=0n)continue;
   const hop:GraphLeg={pool:edge.pool.address,program:edge.pool.program,
    from:edge.from,to:edge.to,amountInRaw:raw.toString(),amountOutRaw:output.toString(),
    poolSlot:edge.pool.poolSlot,vaultSlot:edge.pool.vaultSlot,
    observedAt:edge.pool.observedAt,liquidityUsd:edge.pool.liquidityUsd};
   const hops=[...path,hop];
   if(last){
    if(n!==2&&n!==3)continue;
    const times=hops.map(x=>Date.parse(x.observedAt));
    if(Math.max(...times)-Math.min(...times)>limits.maxGapMs)continue;
    const slots=hops.flatMap(x=>[x.poolSlot,x.vaultSlot]);
    const maxSlotGap=Math.max(...slots)-Math.min(...slots);
    if(maxSlotGap>limits.maxSlotSkew)continue;
    const poolPath=hops.map(x=>x.pool);
    const key=sizeUsd+':'+poolPath.join(':');
    if(seen.has(key))continue;
    seen.add(key);
    const input=BigInt(Math.round(sizeUsd*1_000_000));
    const gross=Number(output-input)/1e6,net=gross-limits.assumedCostUsd;
    if(n===2)twoLegCycles++;else threeLegCycles++;
    if(net>0)positiveIndicative++;
    const candidate:GraphCycle={
     id:key,legs:n as 2|3,
     tokenPath:['USDC',...hops.map(x=>x.to)],poolPath,sizeUsd,
     inputUsdcRaw:input.toString(),outputUsdcRaw:output.toString(),
     grossUsd:gross,assumedCostUsd:limits.assumedCostUsd,
     indicativeNetUsd:net,minObservedAt:new Date(Math.min(...times)).toISOString(),
     maxObservedAt:new Date(Math.max(...times)).toISOString(),maxSlotGap,hops,
     classification:'indicative_only',executable:false,
     caveats:['not_transaction_simulated','independent_pool_snapshots',
      'fees_and_landing_costs_unverified']
    };
    candidates.push(candidate);
   }else{
    usedPools.add(edge.pool.address);visitedMints.add(edge.to);
    recurse(edge.to,output,n,hops,usedPools,visitedMints,sizeUsd);
    visitedMints.delete(edge.to);usedPools.delete(edge.pool.address);
   }
  }
 };
 for(const size of limits.sizesUsd){
  if(truncated)break;
  const input=BigInt(Math.round(size*1_000_000));
  recurse('USDC',input,0,[],new Set<string>(),new Set<GraphAsset>(['USDC']),size);
 }
 candidates.sort((a,b)=>b.indicativeNetUsd-a.indicativeNetUsd||
  a.id.localeCompare(b.id));
 return {phase:'C3B',mode:'READ_ONLY',evaluatedAt:new Date(now).toISOString(),
  elapsedMs:Date.now()-started,poolCount:unique.size,eligiblePools,stalePools,
  pathChecks,truncated,twoLegChecks,threeLegChecks,
  twoLegCycles,threeLegCycles,positiveIndicative,
  bestIndicativeNetUsd:candidates[0]?.indicativeNetUsd??null,
  candidates:candidates.slice(0,limits.maxResults),limitations:[...LIMITATIONS]};
}
