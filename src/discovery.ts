import { Connection, PublicKey } from '@solana/web3.js';

export const SOL_MINT='So11111111111111111111111111111111111111112';
export const USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
import {RAYDIUM_AMM_V4,ORCA_WHIRLPOOL} from './routes.js';
export type DiscoveredPool={address:string;venue:'raydium'|'orca'|'manual';owner:string;liquidityUsd?:number};
type Entry=Record<string,unknown>;
const obj=(v:unknown):Entry|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Entry:null;
const address=(v:unknown):string|undefined=>{if(typeof v!=='string')return;try{return new PublicKey(v).toBase58();}catch{return;}};
const mint=(v:unknown):string|undefined=>address(obj(v)?.address??obj(v)?.mint??v);
export function parseRaydium(value:unknown):Array<{address:string;liquidityUsd?:number}>{
 const root=obj(value);if(!root||root.success!==true)return [];
 const data=obj(root.data);const rows=Array.isArray(data?.data)?data.data:[];
 return rows.flatMap((value:unknown)=>{
  const p=obj(value);if(!p)return [];
  const a=mint(p.mintA),b=mint(p.mintB),id=address(p.id);
  if(!id||!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))return [];
  const tvl=Number(p.tvl);return [{address:id,liquidityUsd:Number.isFinite(tvl)&&tvl>=0?tvl:undefined}];
 });
}
export function parseOrca(value:unknown):Array<{address:string;liquidityUsd?:number}>{
 const root=obj(value);const nested=obj(root?.data);const arr=Array.isArray(root?.data)?root.data:Array.isArray(root?.pools)?root.pools:Array.isArray(nested?.pools)?nested.pools:Array.isArray(nested?.data)?nested.data:undefined;
 if(!Array.isArray(arr))return [];
 return arr.flatMap((value:unknown)=>{
  const p=obj(value);if(!p)return [];
  const a=mint(p.tokenMintA??p.token_mint_a??p.tokenA??p.token_a);
  const b=mint(p.tokenMintB??p.token_mint_b??p.tokenB??p.token_b);
  const id=address(p.address??p.id??p.whirlpool);
  if(!id||!((a===SOL_MINT&&b===USDC_MINT)||(a===USDC_MINT&&b===SOL_MINT)))return [];
  const tvl=Number(p.tvlUsdc??p.tvlUsd??p.tvl);
  return [{address:id,liquidityUsd:Number.isFinite(tvl)&&tvl>=0?tvl:undefined}];
 });
}
async function json(url:string):Promise<unknown>{
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000);
 try{const r=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(timer);}
}
export function choosePoolUniverse(validated:DiscoveredPool[],limit:number,rotation=0):DiscoveredPool[]{
 if(!Number.isSafeInteger(limit)||limit<=0||!Number.isSafeInteger(rotation)||rotation<0)throw new Error('Invalid universe selection');
 const byLiquidity=(a:DiscoveredPool,b:DiscoveredPool)=>(b.liquidityUsd??0)-(a.liquidityUsd??0)||a.address.localeCompare(b.address);
 const unique=[...new Map(validated.map(p=>[p.address,p])).values()];
 const ray=unique.filter(p=>p.owner===RAYDIUM_AMM_V4 && (p.venue==='raydium'||p.venue==='manual')).sort(byLiquidity);
 const orca=unique.filter(p=>p.owner===ORCA_WHIRLPOOL && (p.venue==='orca'||p.venue==='manual')).sort(byLiquidity);
 const rotate=(items:DiscoveredPool[],cap:number)=>{
  if(items.length<=cap)return items;
  const head=items[0],tail=items.slice(1);
  const offset=rotation%tail.length;
  return [head,...Array.from({length:cap-1},(_,i)=>tail[(offset+i)%tail.length])];
 };
 // Keep deep-liquidity anchor pools while periodically rotating other supported
 // SOL/USDC pools. The remaining slots show CLMM and other unquoted coverage.
 const picked=[...rotate(ray,3),...rotate(orca,2)];
 const seen=new Set(picked.map(p=>p.address));
 return [...picked,...unique.filter(p=>!seen.has(p.address)).sort(byLiquidity)].slice(0,limit);
}

export async function discoverPools(connection:Connection,manual:PublicKey[],limit:number,rotation=0):Promise<{pools:DiscoveredPool[];warnings:string[];validatedCount:number}>{
 const warnings:string[]=[];const candidates:Array<{address:string;venue:DiscoveredPool['venue'];liquidityUsd?:number}>=[];
 for(const key of manual)candidates.push({address:key.toBase58(),venue:'manual'});
 const raydiumUrl=new URL('https://api-v3.raydium.io/pools/info/mint');
 for(const [key,val] of Object.entries({mint1:SOL_MINT,mint2:USDC_MINT,poolType:'all',poolSortField:'liquidity',sortType:'desc',pageSize:'100',page:'1'}))raydiumUrl.searchParams.set(key,val);
 const sources=await Promise.allSettled([
  json(raydiumUrl.toString()).then(parseRaydium),
  json('https://api.orca.so/v2/solana/pools').then(parseOrca)
 ]);
 for(const [index,result] of sources.entries()){
  const venue=index===0?'raydium':'orca';
  if(result.status==='rejected'){warnings.push(`${venue} discovery failed: ${String(result.reason)}`);continue;}
  if(!result.value.length)warnings.push(`${venue} discovery returned no recognized SOL/USDC pools (API schema or availability may have changed)`);
  for(const p of result.value)candidates.push({...p,venue});
 }
 const unique=[...new Map(candidates.map(p=>[p.address,p])).values()].sort((a,b)=>(b.liquidityUsd??0)-(a.liquidityUsd??0)).slice(0,Math.min(100,Math.max(limit*4,limit)));
 // Validate a wider candidate set before picking the active SOL/USDC universe.
 const validated:DiscoveredPool[]=[];
 // Every candidate must exist on-chain. Do not accept token mints or executable program accounts.
 for(let start=0;start<unique.length;start+=100){
  const chunk=unique.slice(start,start+100);
  try{
   const accounts=await connection.getMultipleAccountsInfo(chunk.map(p=>new PublicKey(p.address)),'confirmed');
   accounts.forEach((account,i)=>{
    const p=chunk[i];
    if(!account||account.executable||account.data.length<32){warnings.push(`Rejected ${p.venue} account ${p.address}: not a valid pool-state candidate`);return;}
    validated.push({...p,owner:account.owner.toBase58()});
   });
  }catch(e){warnings.push(`RPC validation failed: ${String(e)}`);}
 }
 return {pools:choosePoolUniverse(validated,limit,rotation),warnings,validatedCount:validated.length};
}
