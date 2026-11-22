import {PublicKey,type Connection} from '@solana/web3.js';
import {SOL_MINT,USDC_MINT} from './discovery.js';

const SPL_TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022='TokenzQdBNbLqP5VEhdkAS6EPFhLzVHHnQJjghjZL';
export type TokenCategory='recent'|'trending'|'traded'|'boosted'|'seed';
export type DynamicToken={
 mint:string;symbol:string;decimals:number;tokenProgram:string;
 categories:TokenCategory[];score:number;firstSeenAt:string;lastSeenAt:string;
};
export type TokenDiscoveryHealth={
 phase:'C3D.1';mode:'READ_ONLY';status:'warming'|'ready'|'partial_error'|'disabled';
 lastRefreshAt?:string;lastDurationMs?:number;refreshes:number;
 sourceCounts:Record<string,number>;sourceErrors:string[];
 discovered:number;verifiedMints:number;activeTokens:number;
 excludedUnsupported:number;tokens:DynamicToken[];
};
type Suggestion={mint:string;symbol:string;category:TokenCategory;rank:number};
const pinned=[
 {mint:USDC_MINT,symbol:'USDC'},
 {mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',symbol:'USDT'},
 {mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',symbol:'JUP'}
];
const toObject=(x:unknown):Record<string,unknown>|null=>
 x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const asRows=(value:unknown):unknown[]=>{
 if(Array.isArray(value))return value;
 const p=toObject(value);
 if(Array.isArray(p?.data))return p.data;
 if(Array.isArray(p?.tokens))return p.tokens;
 const nested=toObject(p?.data);
 if(Array.isArray(nested?.tokens))return nested.tokens;
 // DexScreener pairs are useful for non-sponsored mid-cap pool activity.
 // Retain the chain ID for each token before mint validation.
 if(Array.isArray(p?.pairs))return p.pairs.flatMap(pair=>{
  const item=toObject(pair);
  if(!item||item.chainId!=='solana')return [];
  return [item.baseToken,item.quoteToken].map(token=>{
   const t=toObject(token);
   return t?{...t,chainId:'solana',tokenAddress:t.address}:null;
  }).filter(Boolean);
 });
 return [];
};
const safeMint=(value:unknown):string|undefined=>{
 if(typeof value!=='string')return;
 try{return new PublicKey(value).toBase58()}catch{return}
};
export function parseTokenSuggestions(value:unknown,category:TokenCategory):Suggestion[]{
 return asRows(value).flatMap((raw,index)=>{
  const o=toObject(raw);
  if(!o)return [];
  if(category==='boosted'&&o.chainId!=='solana')return [];
  if(o.chainId&&o.chainId!=='solana')return [];
  const mint=safeMint(o.id??o.address??o.mint??o.tokenAddress);
  if(!mint||mint===SOL_MINT||mint===USDC_MINT)return [];
  const symbol=String(o.symbol??o.name??mint.slice(0,5)).replace(/[\u0000-\u001f]/g,'').slice(0,24);
  return [{mint,symbol,category,rank:index}];
 });
}
async function fetchJson(url:string,headers:Record<string,string>,transport:typeof fetch){
 const abort=new AbortController();
 const timer=setTimeout(()=>abort.abort(),8000);
 try{
  const response=await transport(url,{headers:{accept:'application/json',...headers},signal:abort.signal});
  if(!response.ok)throw new Error('HTTP '+response.status);
  return await response.json() as unknown;
 }finally{clearTimeout(timer)}
}
const seeds=()=>pinned.map((x,index)=>({...x,category:'seed' as const,rank:index}));

/** Discovery is part of the existing C3 monitor; not a second scanner.
 * Jupiter is preferred when configured. Keyless DexScreener token profiles
 * provide a weaker fallback. Every new SPL mint is verified on-chain before
 * entering the pool search. API symbols and rankings are informational only.
 */
export class C3TokenDiscovery{
 private active:DynamicToken[]=[];
 private refreshes=0;private refreshing?:Promise<void>;
 private lastRefreshAt?:string;private lastDurationMs?:number;
 private lastAttemptAt=0;
 private errors:string[]=[];
 private sourceCounts:Record<string,number>={};
 private discovered=0;private verifiedMints=0;private excludedUnsupported=0;
 private status:TokenDiscoveryHealth['status']='warming';
 constructor(private readonly connection:Connection,
  private readonly options:{maxTokens:number;refreshMs:number;apiKey?:string;enabled:boolean},
  private readonly transport:typeof fetch=globalThis.fetch){
  if(!Number.isSafeInteger(options.maxTokens)||options.maxTokens<1||options.maxTokens>150||
     !Number.isSafeInteger(options.refreshMs)||options.refreshMs<10000)
   throw new Error('Invalid C3D token discovery options');
  if(!options.enabled)this.status='disabled';
 }
 getTokens():DynamicToken[]{return this.active.map(x=>({...x,categories:[...x.categories]}))}
 snapshot():TokenDiscoveryHealth{
  return {phase:'C3D.1',mode:'READ_ONLY',status:this.status,
   lastRefreshAt:this.lastRefreshAt,lastDurationMs:this.lastDurationMs,
   refreshes:this.refreshes,sourceCounts:{...this.sourceCounts},
   sourceErrors:[...this.errors],discovered:this.discovered,
   verifiedMints:this.verifiedMints,activeTokens:this.active.length,
   excludedUnsupported:this.excludedUnsupported,tokens:this.getTokens()};
 }
 async refresh(now=Date.now()):Promise<DynamicToken[]>{
  if(!this.options.enabled)return this.getTokens();
  if(this.refreshing){await this.refreshing;return this.getTokens()}
  if(this.lastAttemptAt&&now-this.lastAttemptAt<this.options.refreshMs)return this.getTokens();
  this.lastAttemptAt=now;
  this.refreshing=this.perform(now).finally(()=>{this.refreshing=undefined});
  await this.refreshing;
  return this.getTokens();
 }
 private async perform(started:number){
  const key=this.options.apiKey;
  const jobs:Array<{name:TokenCategory;url:string;headers:Record<string,string>}>=key?[
   {name:'recent',url:'https://api.jup.ag/tokens/v2/recent',headers:{'x-api-key':key}},
   {name:'trending',url:'https://api.jup.ag/tokens/v2/toptrending/5m',headers:{'x-api-key':key}},
   {name:'traded',url:'https://api.jup.ag/tokens/v2/toptraded/5m',headers:{'x-api-key':key}}
  ]:[];
  jobs.push(
   {name:'recent',url:'https://api.dexscreener.com/token-profiles/latest/v1',headers:{}},
   {name:'boosted',url:'https://api.dexscreener.com/token-boosts/top/v1',headers:{}},
   {name:'traded',url:'https://api.dexscreener.com/latest/dex/search?q=SOL',headers:{}}
  );
  const results=await Promise.allSettled(jobs.map(j=>fetchJson(j.url,j.headers,this.transport)));
  const scores:Record<TokenCategory,number>={seed:200,recent:140,trending:130,traded:100,boosted:70};
  const proposals=new Map<string,{symbol:string;categories:Set<TokenCategory>;score:number}>();
  const sourceCounts:Record<string,number>={};
  const errors:string[]=[];
  const ingest=(rows:Suggestion[])=>{
   for(const token of rows){
    const prior=proposals.get(token.mint);
    const weight=scores[token.category]-token.rank*0.4;
    if(prior){prior.categories.add(token.category);prior.score+=weight*0.5}
    else proposals.set(token.mint,{symbol:token.symbol,
     categories:new Set([token.category]),score:weight});
   }
  };
  ingest(seeds());
  results.forEach((item,index)=>{
   const job=jobs[index],name=job.name+':'+new URL(job.url).hostname;
   if(item.status==='fulfilled'){
    const rows=parseTokenSuggestions(item.value,job.name);
    sourceCounts[name]=rows.length;ingest(rows);
   }else{
    sourceCounts[name]=0;
    errors.push(name+': '+String(item.reason).slice(0,140));
   }
  });
  this.discovered=proposals.size;
  const ordered=[...proposals.entries()]
   .sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0]));
  const verify=ordered.slice(0,Math.min(180,this.options.maxTokens*3));
  const validated=new Map<string,{decimals:number;program:string}>();
  // Query batches are distributed by the existing dual-RPC HTTP scheduler.
  try{
   for(let i=0;i<verify.length;i+=75){
    const slice=verify.slice(i,i+75);
    const response=await this.connection.getMultipleAccountsInfoAndContext(
     slice.map(([mint])=>new PublicKey(mint)),'confirmed');
    response.value.forEach((info,index)=>{
     if(!info)return;
     const program=info.owner.toBase58();
     if(program!==SPL_TOKEN||info.data.length<82||info.data[45]!==1)return;
     const decimals=info.data[44];
     if(decimals>18)return;
     validated.set(slice[index][0],{decimals,program});
    });
   }
  }catch(error){
   errors.push('Solana mint validation: '+String(error).slice(0,180));
  }
  this.verifiedMints=validated.size;
  this.excludedUnsupported=verify.length-validated.size;
  const old=new Map(this.active.map(t=>[t.mint,t]));
  const next:DynamicToken[]=[];
  for(const [mint,p] of ordered){
   if(next.length>=this.options.maxTokens)break;
   const mintInfo=validated.get(mint);
   if(!mintInfo)continue;
   const previous=old.get(mint);
   next.push({mint,symbol:p.symbol,decimals:mintInfo.decimals,
    tokenProgram:mintInfo.program,categories:[...p.categories],
    score:p.score,firstSeenAt:previous?.firstSeenAt??new Date(started).toISOString(),
    lastSeenAt:new Date(started).toISOString()});
  }
  // Preserve previous verified tokens during upstream API outages.
  // Do not inject unvalidated API-only mint strings into the graph.
  if(!next.length&&this.active.length){
   this.status='partial_error';
  }else{
   this.active=next;
   this.status=errors.length?'partial_error':'ready';
  }
  this.sourceCounts=sourceCounts;this.errors=errors.slice(0,8);
  this.refreshes++;this.lastRefreshAt=new Date(started).toISOString();
  this.lastDurationMs=Date.now()-started;
 }
}
