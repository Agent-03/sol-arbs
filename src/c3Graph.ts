import {amountOutExactInput} from './ammV4.js';
import {cpmmAmountOut} from './c3Cpmm.js';
import {SOL_MINT,USDC_MINT} from './discovery.js';

export type GraphAsset=string;
export type AssetInfo={mint:string;decimals:number;symbol?:string};
const CORE_ASSETS:Readonly<Record<string,AssetInfo>>={

 USDC:{mint:USDC_MINT,decimals:6},
 SOL:{mint:SOL_MINT,decimals:9},
 USDT:{mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',decimals:6},
 JUP:{mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',decimals:6}
};
export const GRAPH_ASSETS:Record<GraphAsset,AssetInfo>={...CORE_ASSETS};
const MINT_TO_ASSET=new Map(Object.entries(GRAPH_ASSETS).map(([name,token])=>[token.mint,name]));
/** Replaces the old four-token whitelist with a bounded, onchain-verified
 * mint registry. Dynamic symbols are display-only; identity is the mint.
 * CORE assets remain pinned for SOL-based bridge routes.
 */
export function replaceDynamicGraphAssets(tokens:readonly {mint:string;decimals:number;symbol?:string}[]){
 for(const name of Object.keys(GRAPH_ASSETS))if(!(name in CORE_ASSETS))delete GRAPH_ASSETS[name];
 MINT_TO_ASSET.clear();
 for(const [name,info] of Object.entries(CORE_ASSETS))MINT_TO_ASSET.set(info.mint,name);
 for(const t of tokens){
  if(!t.mint||!Number.isSafeInteger(t.decimals)||t.decimals<0||t.decimals>18||
   MINT_TO_ASSET.has(t.mint))continue;
  GRAPH_ASSETS[t.mint]={mint:t.mint,decimals:t.decimals,symbol:t.symbol};
  MINT_TO_ASSET.set(t.mint,t.mint);
 }
}
export const assetOfMint=(mint:string):GraphAsset|undefined=>MINT_TO_ASSET.get(mint);
export const displayGraphAsset=(name:GraphAsset)=>GRAPH_ASSETS[name]?.symbol??name;

export type GraphPool={
 address:string;program:'raydium_amm_v4'|'raydium_cpmm'|'orca_whirlpool'|'raydium_clmm';tokenA:GraphAsset;tokenB:GraphAsset;
 reserveA:string;reserveB:string;feeNumerator:string;feeDenominator:string;
 creatorFeeRate?:string;creatorFeeOn?:0|1|2;
 quoteExactInput?:(from:GraphAsset,raw:bigint)=>bigint|null;
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
 // USDC fields are present only for legacy USDC-rooted diagnostic tests.
 sizeUsd?:number;inputUsdcRaw?:string;outputUsdcRaw?:string;
 grossUsd?:number;assumedCostUsd?:number;indicativeNetUsd?:number;
 sizeSol?:number;inputWsolRaw?:string;outputWsolRaw?:string;
 grossSol?:number;assumedCostSol?:number;indicativeNetSol?:number;
 symbolPath:string[];
 minObservedAt:string;maxObservedAt:string;maxSlotGap:number;
 hops:GraphLeg[];classification:'indicative_only';executable:false;
 caveats:string[];
};
export type GraphScanLimits={
 sizesUsd:readonly number[];maxAgeMs:number;maxGapMs:number;maxSlotSkew:number;
 minLiquidityUsd:number;maxPathChecks:number;maxResults:number;assumedCostUsd:number;
 maxPoolInputShareBps?:number;
 baseAsset?:'SOL'|'USDC';sizesSol?:readonly number[];assumedCostSol?:number;
};
export type GraphEvaluation={
 phase:'C3D.1';mode:'READ_ONLY';baseAsset:'SOL'|'USDC';evaluatedAt:string;
 elapsedMs:number;poolCount:number;eligiblePools:number;stalePools:number;
 pathChecks:number;depthRejected:number;truncated:boolean;
 twoLegChecks:number;threeLegChecks:number;
 twoLegCycles:number;threeLegCycles:number;positiveIndicative:number;
 bestIndicativeNetUsd:number|null;bestIndicativeNetSol:number|null;candidates:GraphCycle[];
 limitations:string[];
};
const LIMITATIONS=[
 'C3D.1 dynamic SPL token pool discovery; wSOL-rooted exact-input graph across Raydium and Orca.',
 'New tokens require on-chain mint/program verification; Meteora and PumpSwap pricing are next-stage adapters.',
 'CLMM quotes require complete fresh tick arrays; no mid-price approximation or unverified execution.',
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
 const base=limits.baseAsset??'USDC';
 const probes=base==='SOL'?limits.sizesSol??[]:limits.sizesUsd;
 if(!GRAPH_ASSETS[base]||!Number.isFinite(now)||!probes.length||probes.length>12||
  probes.some(x=>!Number.isFinite(x)||x<=0||x>1_000_000)||
  !validInt(limits.maxAgeMs)||!validInt(limits.maxGapMs)||
  !validInt(limits.maxSlotSkew)||!validInt(limits.maxPathChecks)||
  limits.maxPathChecks<1||!validInt(limits.maxResults)||limits.maxResults<1||
  !Number.isFinite(limits.minLiquidityUsd)||limits.minLiquidityUsd<0||
  !Number.isFinite(limits.assumedCostUsd)||limits.assumedCostUsd<0||
  (base==='SOL'&&(!Number.isFinite(limits.assumedCostSol??0)||(limits.assumedCostSol??0)<0))||
  (limits.maxPoolInputShareBps!==undefined&&
   (!validInt(limits.maxPoolInputShareBps)||limits.maxPoolInputShareBps>10000)))
  throw new Error('Invalid C3D graph scan limits');
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
   const concentrated=pool.program==='orca_whirlpool'||pool.program==='raydium_clmm';
   if((!concentrated&&(ra<=0n||rb<=0n))||fn<0n||fd<=0n||fn>=fd||
      (concentrated&&typeof pool.quoteExactInput!=='function'))throw new Error('invalid model');
   const a:Edge={pool,from:pool.tokenA,to:pool.tokenB,reserveIn:ra,reserveOut:rb,feeNum:fn,feeDen:fd};
   const b:Edge={...a,from:pool.tokenB,to:pool.tokenA,reserveIn:rb,reserveOut:ra};
   edges.set(a.from,[...(edges.get(a.from)??[]),a]);
   edges.set(b.from,[...(edges.get(b.from)??[]),b]);
   eligiblePools++;
  }catch{stalePools++}
 }
 let pathChecks=0,depthRejected=0,twoLegChecks=0,threeLegChecks=0;
 let twoLegCycles=0,threeLegCycles=0,positiveIndicative=0;
 let truncated=false;
 const candidates:GraphCycle[]=[];
 const seen=new Set<string>();
 const recurse=(asset:GraphAsset,raw:bigint,depth:number,path:GraphLeg[],
  usedPools:Set<string>,visitedMints:Set<GraphAsset>,size:number):void=>{
  if(truncated)return;
  if(depth>=3)return;
  for(const edge of edges.get(asset)??[]){
   if(truncated)return;
   if(usedPools.has(edge.pool.address))continue;
   const last=edge.to===base;
   if(last&&depth<1)continue;
   if(!last&&visitedMints.has(edge.to))continue;
   if(!last&&depth>=2)continue;
   if(pathChecks>=limits.maxPathChecks){truncated=true;return;}
   pathChecks++;
   const n=depth+1;
   if(limits.maxPoolInputShareBps!==undefined&&
      ((edge.pool.program==='orca_whirlpool'||edge.pool.program==='raydium_clmm')
       ?(base==='USDC'&&
         (edge.pool.liquidityUsd===null||size*10000>edge.pool.liquidityUsd*limits.maxPoolInputShareBps))
       :raw*10000n>edge.reserveIn*BigInt(limits.maxPoolInputShareBps))){
    depthRejected++;continue;
   }
   if(n===2)twoLegChecks++;
   if(n===3)threeLegChecks++;
   let output:bigint;
   try{output=edge.pool.program==='orca_whirlpool'||edge.pool.program==='raydium_clmm'
     ?(edge.pool.quoteExactInput?.(edge.from,raw)??0n)
     :edge.pool.program==='raydium_cpmm'
     ?cpmmAmountOut(raw,edge.reserveIn,edge.reserveOut,
       edge.feeNum,BigInt(edge.pool.creatorFeeRate??'-1'),
       edge.pool.creatorFeeOn??-1 as 0|1|2,
       edge.from===edge.pool.tokenA)
     :amountOutExactInput(raw,edge.reserveIn,edge.reserveOut,edge.feeNum,edge.feeDen);}
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
    const key=base+':'+size+':'+poolPath.join(':');
    if(seen.has(key))continue;
    seen.add(key);
    const input=BigInt(Math.round(size*(base==='SOL'?1_000_000_000:1_000_000)));
    const gross=Number(output-input)/(base==='SOL'?1e9:1e6);
    const cost=base==='SOL'?(limits.assumedCostSol??0):limits.assumedCostUsd;
    const net=gross-cost;
    if(n===2)twoLegCycles++;else threeLegCycles++;
    if(net>0)positiveIndicative++;
    const candidate:GraphCycle={
     id:key,legs:n as 2|3,
     tokenPath:[base,...hops.map(x=>x.to)],
     symbolPath:[base,...hops.map(x=>displayGraphAsset(x.to))],poolPath,
     ...(base==='SOL'?{
      sizeSol:size,inputWsolRaw:input.toString(),outputWsolRaw:output.toString(),
      grossSol:gross,assumedCostSol:cost,indicativeNetSol:net
     }:{
      sizeUsd:size,inputUsdcRaw:input.toString(),outputUsdcRaw:output.toString(),
      grossUsd:gross,assumedCostUsd:cost,indicativeNetUsd:net
     }),
     minObservedAt:new Date(Math.min(...times)).toISOString(),
     maxObservedAt:new Date(Math.max(...times)).toISOString(),maxSlotGap,hops,
     classification:'indicative_only',executable:false,
     caveats:['not_transaction_simulated','independent_pool_snapshots',
      'fees_and_landing_costs_unverified']
    };
    candidates.push(candidate);
   }else{
    usedPools.add(edge.pool.address);visitedMints.add(edge.to);
    recurse(edge.to,output,n,hops,usedPools,visitedMints,size);
    visitedMints.delete(edge.to);usedPools.delete(edge.pool.address);
   }
  }
 };
 // Evaluate every configured wSOL amount independently; exact raw units.
 for(const size of [...new Set(probes)].sort((a,b)=>b-a)){
  if(truncated)break;
  const input=BigInt(Math.round(size*(base==='SOL'?1_000_000_000:1_000_000)));
  recurse(base,input,0,[],new Set<string>(),new Set<GraphAsset>([base]),size);
 }
 candidates.sort((a,b)=>
  (b.indicativeNetSol??b.indicativeNetUsd??0)-(a.indicativeNetSol??a.indicativeNetUsd??0)||
  a.id.localeCompare(b.id));
 return {phase:'C3D.1',baseAsset:base,mode:'READ_ONLY',evaluatedAt:new Date(now).toISOString(),
  elapsedMs:Date.now()-started,poolCount:unique.size,eligiblePools,stalePools,
  pathChecks,depthRejected,truncated,twoLegChecks,threeLegChecks,
  twoLegCycles,threeLegCycles,positiveIndicative,
  bestIndicativeNetUsd:base==='USDC'?candidates[0]?.indicativeNetUsd??null:null,
  bestIndicativeNetSol:base==='SOL'?candidates[0]?.indicativeNetSol??null:null,
  candidates:candidates.slice(0,limits.maxResults),limitations:[...LIMITATIONS]};
}
