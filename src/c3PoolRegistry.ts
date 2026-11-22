import {createHash} from 'node:crypto';
import {Connection,PublicKey,type AccountInfo} from '@solana/web3.js';
import {ParsableWhirlpool} from '@orca-so/whirlpools-sdk';
import {PoolInfoLayout} from '@raydium-io/raydium-sdk-v2';
import {decodeAmmV4AnyPair} from './ammV4.js';
import {decodeCpmmPool,RAYDIUM_CPMM} from './c3Cpmm.js';
import {RAYDIUM_AMM_V4,RAYDIUM_CLMM,ORCA_WHIRLPOOL} from './routes.js';
import {GRAPH_ASSETS,type GraphPool} from './c3Graph.js';

export const METEORA_DLMM='LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const METEORA_DAMM_V2='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const PUMPSWAP_AMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export type RegistryProgram='raydium_amm_v4'|'raydium_cpmm'|'raydium_clmm'|
 'orca_whirlpool'|'meteora_dlmm'|'meteora_damm_v2'|'pumpswap_amm';
export type RegistryVenue='raydium'|'orca'|'meteora'|'pumpswap';
export type RegistryPool={
 address:string;mintA:string;mintB:string;venue:RegistryVenue;
 program:RegistryProgram;owner:string;liquidityUsd:number;dexId:string;
 firstSeenAt:string;lastSeenAt:string;lastVerifiedSlot:number;
 quoteStatus:'ready'|'not_ready'|'unsupported';
 quoteReason:string;
};
export type TokenPoolCoverage={
 mint:string;symbol:string;poolCount:number;venueCount:number;readyPools:number;
 crossDexPairs:number;readyTwoLegPairs:number;venues:string[];
 pools:RegistryPool[];
};
export type PoolRegistrySnapshot={
 phase:'C3D.2';mode:'READ_ONLY';status:'warming'|'ready'|'partial_error'|'disabled';
 lastRefreshAt?:string;durationMs?:number;refreshes:number;
 tokensQueried:number;apiCandidates:number;onchainVerified:number;
 unsupportedQuotePools:number;ownerRejected:number;mintRejected:number;
 trackedPools:number;readyPools:number;tokensWithMultiplePools:number;
 crossDexPairs:number;readyTwoLegPairs:number;potentialTwoLegPairs:number;
 perVenue:Record<RegistryVenue,{tracked:number;ready:number}>;
 tokens:TokenPoolCoverage[];pools:RegistryPool[];errors:string[];
};
type MetadataCandidate={
 address:string;mintA:string;mintB:string;liquidityUsd:number;dexId:string;
};
const OWNERS:Record<string,{program:RegistryProgram;venue:RegistryVenue}>={
 [RAYDIUM_AMM_V4]:{program:'raydium_amm_v4',venue:'raydium'},
 [RAYDIUM_CPMM]:{program:'raydium_cpmm',venue:'raydium'},
 [RAYDIUM_CLMM]:{program:'raydium_clmm',venue:'raydium'},
 [ORCA_WHIRLPOOL]:{program:'orca_whirlpool',venue:'orca'},
 [METEORA_DLMM]:{program:'meteora_dlmm',venue:'meteora'},
 [METEORA_DAMM_V2]:{program:'meteora_damm_v2',venue:'meteora'},
 [PUMPSWAP_AMM]:{program:'pumpswap_amm',venue:'pumpswap'}
};
const QUOTABLE=new Set<RegistryProgram>([
 'raydium_amm_v4','raydium_cpmm','raydium_clmm','orca_whirlpool'
]);
const pubkey=(value:unknown):string|undefined=>{
 if(typeof value!=='string')return;
 try{return new PublicKey(value).toBase58()}catch{return}
};
const toRecord=(x:unknown):Record<string,unknown>|null=>
 !!x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;

/** DexScreener is an UNTRUSTED pool-address hint. Its claimed DEX, pair
 * identity and TVL never replace Solana program-owner and mint validation.
 * Supports the official token-pairs/v1 endpoint (array) and legacy object.
 */
export function parsePoolMetadata(payload:unknown,activeMints:ReadonlySet<string>,
 minLiquidityUsd:number):MetadataCandidate[]{
 const obj=toRecord(payload);
 const rows=Array.isArray(payload)?payload:Array.isArray(obj?.pairs)?obj.pairs:[];
 const dedup=new Map<string,MetadataCandidate>();
 for(const item of rows){
  const p=toRecord(item);if(!p||p.chainId!=='solana')continue;
  const address=pubkey(p.pairAddress),a=pubkey(toRecord(p.baseToken)?.address);
  const b=pubkey(toRecord(p.quoteToken)?.address);
  if(!address||!a||!b||a===b||!activeMints.has(a)||!activeMints.has(b))continue;
  const tvl=Number(toRecord(p.liquidity)?.usd);
  if(!Number.isFinite(tvl)||tvl<minLiquidityUsd||tvl<=0)continue;
  const current=dedup.get(address);
  if(!current||current.liquidityUsd<tvl)
   dedup.set(address,{address,mintA:a,mintB:b,liquidityUsd:tvl,
    dexId:String(p.dexId??'unknown').slice(0,36)});
 }
 return [...dedup.values()].sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
}

const disc=(value:string)=>createHash('sha256').update('account:'+value).digest().subarray(0,8);
const DLMM_DISC=Buffer.from([33,11,49,98,181,101,177,13]);
const DAMM_DISC=Buffer.from([241,154,109,4,17,177,109,188]);
const PUMP_DISC=disc('Pool');
const readMint=(data:Buffer,offset:number)=>new PublicKey(data.subarray(offset,offset+32)).toBase58();
/** Mint offsets are from the official Meteora DLMM/DAMM-v2 zero-copy IDLs,
 * and PumpSwap's official Anchor Pool layout; all are gated by an exact
 * account discriminator before interpretation. Unknown layouts fail closed.
 * These parsers are for identity checks only, NOT swap-price calculations.
 */
export function decodeRegistryPoolMints(address:string,info:AccountInfo<Buffer>):
 {mintA:string;mintB:string;program:RegistryProgram;venue:RegistryVenue}|null{
 const owner=info.owner.toBase58(),kind=OWNERS[owner],data=Buffer.from(info.data);
 if(!kind||info.executable)return null;
 try{
  let mintA:string,mintB:string;
  switch(kind.program){
   case 'raydium_amm_v4':{
    const value=decodeAmmV4AnyPair(address,data);
    mintA=value.baseMint;mintB=value.quoteMint;break;
   }
   case 'raydium_cpmm':{
    const value=decodeCpmmPool(data);
    mintA=value.mintA;mintB=value.mintB;break;
   }
   case 'raydium_clmm':{
    const value=PoolInfoLayout.decode(data);
    mintA=value.mintA.toBase58();mintB=value.mintB.toBase58();break;
   }
   case 'orca_whirlpool':{
    const value=ParsableWhirlpool.parse(new PublicKey(address),info);
    if(!value)return null;
    mintA=value.tokenMintA.toBase58();mintB=value.tokenMintB.toBase58();break;
   }
   case 'meteora_dlmm':{
    if(data.length<216||!data.subarray(0,8).equals(DLMM_DISC))return null;
    // LbPair: static(32), variable(32), flags/active id/step(16)
    mintA=readMint(data,88);mintB=readMint(data,120);break;
   }
   case 'meteora_damm_v2':{
    if(data.length<272||!data.subarray(0,8).equals(DAMM_DISC))return null;
    // Official DAMM-v2 SDK: discriminator 8 + 160-byte PoolFeesStruct.
    // POOL_TOKEN_A_MINT_OFFSET=168, POOL_TOKEN_B_MINT_OFFSET=200.
    mintA=readMint(data,168);mintB=readMint(data,200);break;
   }
   case 'pumpswap_amm':{
    if(data.length<170||!data.subarray(0,8).equals(PUMP_DISC))return null;
    // Pool: Anchor discriminator(8), bump u8, index u16,
    // creator pubkey, base mint, quote mint.
    mintA=readMint(data,43);mintB=readMint(data,75);
    const creator=data.subarray(11,43),index=data.subarray(9,11);
    const derived=PublicKey.findProgramAddressSync([
     Buffer.from('pool'),index,creator,
     new PublicKey(mintA).toBuffer(),new PublicKey(mintB).toBuffer()
    ],new PublicKey(owner))[0].toBase58();
    if(derived!==address)return null;
    break;
   }
  }
  if(mintA===mintB)return null;
  return {mintA,mintB,program:kind.program,venue:kind.venue};
 }catch{return null}
}

/** Only feeds the existing C3 graph; owns no independent price/route engine. */
export class C3PoolRegistry{
 private rows=new Map<string,RegistryPool>();
 private tokens:string[]=[];
 private refreshTask?:Promise<void>;private latestAt?:string;private durationMs?:number;
 private refreshes=0;private cursor=0;private lastAttempt=0;
 private errors:string[]=[];
 private queried=0;private candidates=0;private verified=0;
 private ownerRejected=0;private mintRejected=0;
 private ready=new Set<string>();
 private status:PoolRegistrySnapshot['status']='warming';
 constructor(private readonly rpc:Connection,private readonly opts:{
  enabled:boolean;maxTokensPerRefresh:number;concurrency:number;
  refreshMs:number;minLiquidityUsd:number;maxPools:number;ttlMs:number;
 },private readonly transport:typeof fetch=globalThis.fetch){
  if(!Number.isSafeInteger(opts.maxTokensPerRefresh)||opts.maxTokensPerRefresh<1||
    opts.maxTokensPerRefresh>100||
    !Number.isSafeInteger(opts.concurrency)||opts.concurrency<1||opts.concurrency>20||
    !Number.isSafeInteger(opts.maxPools)||opts.maxPools<1||opts.maxPools>2000||
    !Number.isSafeInteger(opts.ttlMs)||opts.ttlMs<opts.refreshMs||
    !Number.isSafeInteger(opts.refreshMs)||opts.refreshMs<10000||
    !Number.isFinite(opts.minLiquidityUsd)||opts.minLiquidityUsd<0)
   throw new Error('Invalid C3D.2 pool registry settings');
  if(!opts.enabled)this.status='disabled';
 }
 /** Refresh the listed active token universe, while rotating network calls
  * over a bounded number of SPL mints. Other tokens' verified pools persist
  * until their TTL expires or the mint leaves the active token universe.
  */
 async refresh(allMints:readonly string[],now=Date.now()):Promise<void>{
  this.tokens=[...new Set(allMints.filter(pubkey))];
  const allowed=new Set(Object.values(GRAPH_ASSETS).map(x=>x.mint));
  this.prune(now,allowed);
  if(!this.opts.enabled)return;
  if(this.refreshTask){await this.refreshTask;return}
  if(this.lastAttempt&&now-this.lastAttempt<this.opts.refreshMs)return;
  this.lastAttempt=now;
  this.refreshTask=this.perform(allowed,now).finally(()=>{this.refreshTask=undefined});
  await this.refreshTask;
 }
 observeReady(pools:readonly GraphPool[]){
  this.ready=new Set(pools.map(p=>p.address));
 }
 private prune(now:number,allowed:Set<string>){
  for(const [id,p] of this.rows){
   if(!allowed.has(p.mintA)||!allowed.has(p.mintB)||
      now-Date.parse(p.lastSeenAt)>this.opts.ttlMs)this.rows.delete(id);
  }
  if(this.rows.size>this.opts.maxPools){
   const ordered=[...this.rows.values()].sort((a,b)=>
    Number(b.quoteStatus==='ready')-Number(a.quoteStatus==='ready')||
    b.liquidityUsd-a.liquidityUsd||b.lastSeenAt.localeCompare(a.lastSeenAt));
   const keep=new Set(ordered.slice(0,this.opts.maxPools).map(p=>p.address));
   for(const id of this.rows.keys())if(!keep.has(id))this.rows.delete(id);
  }
 }
 private async fetchPairs(mint:string):Promise<MetadataCandidate[]>{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),9000);
  try{
   const r=await this.transport('https://api.dexscreener.com/token-pairs/v1/solana/'+mint,{
    headers:{accept:'application/json'},signal:controller.signal
   });
   if(!r.ok)throw Error('DexScreener HTTP '+r.status);
   return parsePoolMetadata(await r.json(),new Set(Object.values(GRAPH_ASSETS).map(x=>x.mint)),
    this.opts.minLiquidityUsd);
  }finally{clearTimeout(timer)}
 }
 private async perform(allowed:Set<string>,at:number):Promise<void>{
  const start=Date.now();
  const selected:string[]=[];
  const capacity=Math.min(this.tokens.length,this.opts.maxTokensPerRefresh);
  const front=this.tokens.slice(0,Math.min(3,capacity));
  selected.push(...front);
  const rest=this.tokens.slice(front.length);
  const position=rest.length?this.cursor%rest.length:0;
  for(let i=0;i<rest.length&&selected.length<capacity;i++)
   selected.push(rest[(position+i)%rest.length]);
  this.cursor+=Math.max(1,capacity-front.length);
  const responses:MetadataCandidate[][]=new Array(selected.length);
  let index=0,requestsOk=0;
  const errors:string[]=[];
  const workers=Math.min(selected.length,this.opts.concurrency);
  await Promise.all(Array.from({length:workers},async()=>{
   while(index<selected.length){
    const n=index++;
    try{responses[n]=await this.fetchPairs(selected[n]);requestsOk++}
    catch(error){responses[n]=[];errors.push(selected[n]+': '+String(error).slice(0,100))}
   }
  }));
  const distinct=new Map<string,MetadataCandidate>();
  for(const list of responses)for(const pool of list){
   const existing=distinct.get(pool.address);
   if(!existing||existing.liquidityUsd<pool.liquidityUsd)distinct.set(pool.address,pool);
  }
  const poolHints=[...distinct.values()]
   .sort((a,b)=>b.liquidityUsd-a.liquidityUsd)
   .slice(0,Math.max(this.opts.maxPools,100));
  this.queried=selected.length;this.candidates=distinct.size;
  this.ownerRejected=0;this.mintRejected=0;this.verified=0;
  for(let i=0;i<poolHints.length;i+=75){
   const batch=poolHints.slice(i,i+75);
   try{
    const result=await this.rpc.getMultipleAccountsInfoAndContext(
     batch.map(x=>new PublicKey(x.address)),'confirmed');
    result.value.forEach((info,j)=>{
     const candidate=batch[j];
     if(!info||!OWNERS[info.owner.toBase58()]){this.ownerRejected++;return}
     const verified=decodeRegistryPoolMints(candidate.address,info);
     if(!verified||!allowed.has(verified.mintA)||!allowed.has(verified.mintB)||
        !([candidate.mintA,candidate.mintB].includes(verified.mintA)&&
          [candidate.mintA,candidate.mintB].includes(verified.mintB))){
      this.mintRejected++;return;
     }
     this.verified++;
     const before=this.rows.get(candidate.address);
     this.rows.set(candidate.address,{
      address:candidate.address,mintA:verified.mintA,mintB:verified.mintB,
      owner:info.owner.toBase58(),venue:verified.venue,program:verified.program,
      dexId:candidate.dexId,liquidityUsd:candidate.liquidityUsd,
      firstSeenAt:before?.firstSeenAt??new Date(at).toISOString(),
      lastSeenAt:new Date(at).toISOString(),lastVerifiedSlot:result.context.slot,
      quoteStatus:QUOTABLE.has(verified.program)?'not_ready':'unsupported',
      quoteReason:QUOTABLE.has(verified.program)?
       'awaiting_active_local_quote_snapshot':'protocol_quote_adapter_not_yet_implemented'
     });
    });
   }catch(error){errors.push('On-chain pool verification: '+String(error).slice(0,180))}
  }
  this.prune(at,allowed);
  this.refreshes++;
  this.latestAt=new Date(at).toISOString();this.durationMs=Date.now()-start;
  this.errors=errors.slice(0,12);
  this.status=errors.length?'partial_error':'ready';
 }
 /** A lightweight snapshot; all readiness comes from *real* quote-adapter
  * graph pools. Metadata API prices are never inserted into the graph.
  */
 snapshot():PoolRegistrySnapshot{
  const rows=[...this.rows.values()].map(p=>{
   const ready=this.ready.has(p.address)&&QUOTABLE.has(p.program);
   return {...p,quoteStatus:(ready?'ready':QUOTABLE.has(p.program)?
    'not_ready':'unsupported') as RegistryPool['quoteStatus'],
    quoteReason:ready?'':QUOTABLE.has(p.program)?
     'local_quote_snapshot_missing_or_stale':'protocol_quote_adapter_not_yet_implemented'};
  }).sort((a,b)=>b.liquidityUsd-a.liquidityUsd||a.address.localeCompare(b.address));
  const byMint=new Map<string,TokenPoolCoverage>();
  for(const mint of this.tokens)byMint.set(mint,{
   mint,symbol:Object.values(GRAPH_ASSETS).find(t=>t.mint===mint)?.symbol??
    Object.keys(GRAPH_ASSETS).find(k=>GRAPH_ASSETS[k].mint===mint)??mint.slice(0,6),
   poolCount:0,venueCount:0,readyPools:0,crossDexPairs:0,
   readyTwoLegPairs:0,venues:[],pools:[]
  });
  const pairs=new Map<string,RegistryPool[]>();
  const poolsByToken=new Map<string,Set<string>>();
  for(const p of rows){
   for(const mint of [p.mintA,p.mintB]){
    const token=byMint.get(mint);if(!token)continue;
    token.pools.push(p);
    const counterpart=p.mintA===mint?p.mintB:p.mintA;
    const id=mint+':'+counterpart;
    const list=pairs.get(id)??[];list.push(p);pairs.set(id,list);
    const seen=poolsByToken.get(mint)??new Set<string>();
    seen.add(p.address);poolsByToken.set(mint,seen);
   }
  }
  let crossDexPairs=0,readyTwoLegPairs=0,potentialTwoLegPairs=0;
  for(const [id,list] of pairs){
   const venues=new Set(list.map(x=>x.venue));
   const crosses=venues.size>=2;
   if(crosses)crossDexPairs++;
   if(list.length>=2)potentialTwoLegPairs++;
   if(list.filter(x=>x.quoteStatus==='ready').length>=2)readyTwoLegPairs++;
   const target=byMint.get(id.slice(0,id.indexOf(':')));
   if(target&&crosses)target.crossDexPairs++;
   if(target&&list.filter(x=>x.quoteStatus==='ready').length>=2)target.readyTwoLegPairs++;
  }
  // Token/quote pairs are represented once per target token, not counted
  // twice for anchor mints that happen to be in the active discovery list.
  const tokens=[...byMint.values()].map(x=>{
   x.poolCount=poolsByToken.get(x.mint)?.size??0;
   x.readyPools=x.pools.filter(p=>p.quoteStatus==='ready').length;
   x.venues=[...new Set(x.pools.map(p=>p.venue))].sort();
   x.venueCount=x.venues.length;
   x.pools.sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
   return x;
  }).sort((a,b)=>b.venueCount-a.venueCount||b.poolCount-a.poolCount||a.symbol.localeCompare(b.symbol));
  const perVenue:PoolRegistrySnapshot['perVenue']={
   raydium:{tracked:0,ready:0},orca:{tracked:0,ready:0},
   meteora:{tracked:0,ready:0},pumpswap:{tracked:0,ready:0}
  };
  for(const p of rows){
   perVenue[p.venue].tracked++;
   if(p.quoteStatus==='ready')perVenue[p.venue].ready++;
  }
  return {phase:'C3D.2',mode:'READ_ONLY',status:this.status,
   lastRefreshAt:this.latestAt,durationMs:this.durationMs,refreshes:this.refreshes,
   tokensQueried:this.queried,apiCandidates:this.candidates,onchainVerified:this.verified,
   unsupportedQuotePools:rows.filter(p=>p.quoteStatus==='unsupported').length,
   ownerRejected:this.ownerRejected,mintRejected:this.mintRejected,
   trackedPools:rows.length,readyPools:rows.filter(p=>p.quoteStatus==='ready').length,
   tokensWithMultiplePools:tokens.filter(x=>x.poolCount>=2).length,
   crossDexPairs,readyTwoLegPairs,potentialTwoLegPairs,perVenue,
   pools:rows,tokens,errors:[...this.errors]};
 }
 supported():RegistryPool[]{return this.snapshot().pools.filter(p=>QUOTABLE.has(p.program))}
 stop(){this.ready.clear();this.rows.clear();this.tokens=[];this.status='disabled'}
}
