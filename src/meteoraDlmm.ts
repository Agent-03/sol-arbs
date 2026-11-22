import {PublicKey,type Connection} from '@solana/web3.js';
import {createRequire} from 'node:module';
import type * as MeteoraTypes from '@meteora-ag/dlmm';
import type {BinArrayAccount} from '@meteora-ag/dlmm';
// Published SDK ESM entry cannot load its Anchor CommonJS directory imports
// under NodeNext. Resolve the package's supported CommonJS entry explicitly.
// Its CJS export is the DLMM class itself, not {default: DLMM}.
const DLMM=createRequire(import.meta.url)('@meteora-ag/dlmm')
 as typeof MeteoraTypes.default.default;
type DLMM=InstanceType<typeof MeteoraTypes.default.default>;
import BN from 'bn.js';
import {METEORA_DLMM,type RegistryPool} from './c3PoolRegistry.js';
import {GRAPH_ASSETS,assetOfMint,type GraphPool} from './c3Graph.js';
import {validateLocalComponents} from './localWhirlpool.js';
import type {MarketDataFeed,MarketObservation} from './marketData.js';

export type DlmmPoolReadiness={
 address:string;pair:string;status:'ready'|'warming'|'not_ready';
 reason?:string;binArrays:number;oldestAgeMs:number|null;
 slotGap:number|null;lastQuoteAt?:string;
};
export type DlmmHealth={
 status:'disabled'|'warming'|'ready'|'partial_error'|'stopped';
 tracked:number;ready:number;bootstrapAttempts:number;bootstrapFailures:number;
 localQuotes:number;quoteFailures:number;verifiedAccountRefreshes:number;
 pending:number;lastRefreshAt?:string;perPool:DlmmPoolReadiness[];errors:string[];
};
type Candidate={address:string;mintA:string;mintB:string;liquidityUsd:number};
type Entry={
 candidate:Candidate;sdk:DLMM;binX:string[];binY:string[];
 releases:Map<string,()=>void>;lastQuoteAt?:string;quoteFailure?:string;
};
type Observed={data:Buffer;verifiedAt:number;verifiedSlot:number;owner:string};
const ctxPrefix='c3dlmm:';
const core=(obs:MarketObservation):Observed=>({
 data:Buffer.from(obs.data),verifiedAt:obs.verifiedAt,
 verifiedSlot:obs.verifiedSlot,owner:obs.owner
});
const message=(error:unknown)=>String(error).slice(0,190);
const unique=(addresses:readonly string[])=>[...new Set(addresses)];

/** Local exact-input Meteora DLMM quotes.
 * The official SDK supplies dynamic fees, bin traversal and integer rounding.
 * The quote path is synchronous and uses only feed-verified account bytes:
 * no remote quotes, no third-party mid prices, no wallet or transaction code.
 */
export class MeteoraDlmmMonitor{
 private readonly entries=new Map<string,Entry>();
 private candidates:Candidate[]=[];
 private readonly pending=new Set<string>();
 private running=false;private refreshing=false;
 private timer?:ReturnType<typeof setInterval>;
 private eventRelease?:()=>void;
 private status:DlmmHealth['status']='disabled';
 private errors:string[]=[];
 private bootstrapAttempts=0;private bootstrapFailures=0;
 private localQuotes=0;private quoteFailures=0;
 private verifiedAccountRefreshes=0;
 private lastRefreshAt?:string;
 constructor(private readonly rpc:Connection,private readonly feed:MarketDataFeed,
  private readonly opts:{
   enabled:boolean;maxPools:number;maxAgeMs:number;maxSlotSkew:number;
   refreshMs:number;concurrency:number;minLiquidityUsd:number;maxArraysPerSide:number;
  },
  private readonly onChange:()=>void){
  if(!Number.isSafeInteger(opts.maxPools)||opts.maxPools<1||opts.maxPools>40||
   !Number.isSafeInteger(opts.concurrency)||opts.concurrency<1||opts.concurrency>8||
   !Number.isSafeInteger(opts.maxAgeMs)||opts.maxAgeMs<1000||
   !Number.isSafeInteger(opts.maxSlotSkew)||opts.maxSlotSkew<0||
   !Number.isSafeInteger(opts.refreshMs)||opts.refreshMs<2500||
   !Number.isSafeInteger(opts.maxArraysPerSide)||opts.maxArraysPerSide<1||
   opts.maxArraysPerSide>8)throw Error('Invalid Meteora DLMM quote monitor limits');
 }
 private report(error:string){
  this.errors.unshift(error);
  this.errors=this.errors.slice(0,10);
 }
 start(){
  if(this.running||!this.opts.enabled)return;
  this.running=true;this.status='warming';
  this.eventRelease=this.feed.onUpdate(update=>{
   if(!this.running||!update.affectedPools.some(x=>x.startsWith(ctxPrefix)))return;
   this.onChange();
  });
  this.timer=setInterval(()=>void this.refresh(),this.opts.refreshMs);
 }
 setCandidates(rows:readonly RegistryPool[]){
  if(!this.running)return;
  const sol=GRAPH_ASSETS.SOL.mint;
  this.candidates=rows
   .filter(x=>x.program==='meteora_dlmm'&&x.owner===METEORA_DLMM&&
    x.liquidityUsd>=this.opts.minLiquidityUsd&&
    assetOfMint(x.mintA)!==undefined&&assetOfMint(x.mintB)!==undefined)
   .map(x=>({address:x.address,mintA:x.mintA,mintB:x.mintB,
    liquidityUsd:x.liquidityUsd}))
   .sort((a,b)=>Number(b.mintA===sol||b.mintB===sol)-
    Number(a.mintA===sol||a.mintB===sol)||
    b.liquidityUsd-a.liquidityUsd)
   .slice(0,this.opts.maxPools);
  const allowed=new Set(this.candidates.map(x=>x.address));
  for(const address of this.entries.keys())
   if(!allowed.has(address))this.forget(address);
  void this.refresh();
 }
 private forget(address:string){
  const entry=this.entries.get(address);if(!entry)return;
  entry.releases.forEach(release=>release());
  entry.releases.clear();this.entries.delete(address);
  this.feed.clearDependencies(ctxPrefix+address);
 }
 private arrays(entry:Entry){
  return unique([...entry.binX,...entry.binY]);
 }
 private observed(address:string):Observed|null{
  const obs=this.feed.get(address);
  return obs?core(obs):null;
 }
 private async updateArrays(entry:Entry):Promise<void>{
  const sdk=entry.sdk;
  const x=await sdk.getBinArrayForSwap(true,this.opts.maxArraysPerSide);
  const y=await sdk.getBinArrayForSwap(false,this.opts.maxArraysPerSide);
  const binX=unique(x.map(a=>a.publicKey.toBase58()));
  const binY=unique(y.map(a=>a.publicKey.toBase58()));
  if(!binX.length||!binY.length)throw Error('bin_arrays_missing_direction');
  const all=unique([entry.candidate.address,...binX,...binY]);
  for(const address of all){
   if(entry.releases.has(address))continue;
   this.feed.expectOwner(address,METEORA_DLMM);
   entry.releases.set(address,this.feed.watch(address));
  }
  for(const [key,release] of entry.releases)if(!all.includes(key)){
   release();entry.releases.delete(key);
  }
  this.feed.setDependencies(ctxPrefix+entry.candidate.address,all);
  entry.binX=binX;entry.binY=binY;
  await this.feed.reconcile(all,'rpc_bootstrap');
  this.verifiedAccountRefreshes++;
 }
 private async bootstrap(candidate:Candidate){
  if(!this.running||this.entries.has(candidate.address)||this.pending.has(candidate.address))return;
  this.pending.add(candidate.address);this.bootstrapAttempts++;
  let entry:Entry|undefined;
  try{
   const sdk=await DLMM.create(this.rpc,new PublicKey(candidate.address));
   if(!this.running)return;
   const a=sdk.lbPair.tokenXMint.toBase58(),b=sdk.lbPair.tokenYMint.toBase58();
   if(!((a===candidate.mintA&&b===candidate.mintB)||
     (a===candidate.mintB&&b===candidate.mintA)))throw Error('mint_pair_mismatch');
   if(!assetOfMint(a)||!assetOfMint(b))throw Error('mint_left_active_universe');
   // Exact fee transfer semantics are currently supported for classic SPL.
   const tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
   if(sdk.tokenX.owner.toBase58()!==tokenProgram||
      sdk.tokenY.owner.toBase58()!==tokenProgram)
    throw Error('token_extension_quote_not_enabled');
   entry={candidate,sdk,binX:[],binY:[],releases:new Map()};
   await this.updateArrays(entry);
   if(!this.running){entry.releases.forEach(release=>release());return}
   this.entries.set(candidate.address,entry);
   this.onChange();
  }catch(error){
   entry?.releases.forEach(release=>release());
   this.feed.clearDependencies(ctxPrefix+candidate.address);
   this.bootstrapFailures++;
   this.report(candidate.address+': '+message(error));
  }finally{this.pending.delete(candidate.address)}
 }
 async refresh(){
  if(!this.running||this.refreshing)return;
  this.refreshing=true;
  try{
   const queued=this.candidates.filter(c=>!this.entries.has(c.address)&&
    !this.pending.has(c.address));
   let cursor=0;
   await Promise.all(Array.from({length:Math.min(this.opts.concurrency,queued.length)},
    async()=>{while(cursor<queued.length&&this.running)await this.bootstrap(queued[cursor++])}));
   if(!this.running)return;
   const all=unique([...this.entries.values()].flatMap(x=>
    [x.candidate.address,...this.arrays(x)]));
   if(all.length){
    await this.feed.reconcile(all,'rpc_reconcile');
    this.verifiedAccountRefreshes++;
   }
   this.lastRefreshAt=new Date().toISOString();
   this.onChange();
   this.status=this.errors.length?'partial_error':'ready';
  }catch(error){
   this.report('Meteora refresh: '+message(error));this.status='partial_error';
  }finally{this.refreshing=false}
 }
 private state(entry:Entry,now=Date.now()):{
  ok:boolean;reason?:string;observedAt?:number;poolSlot?:number;tickSlot?:number;
  slotGap?:number;oldestAgeMs?:number
 }{
  const addresses=[entry.candidate.address,...this.arrays(entry)];
  if(entry.binX.length===0||entry.binY.length===0)
   return {ok:false,reason:'bin_arrays_not_prepared'};
  const observations:Observed[]=[];
  for(const address of addresses){
   const info=this.observed(address);
   if(!info)return {ok:false,reason:address===entry.candidate.address?
    'pool_state_missing':'bin_array_missing:'+address};
   if(info.owner!==METEORA_DLMM)return {ok:false,reason:'account_owner_mismatch'};
   observations.push(info);
  }
  const checks=observations.map(x=>({slot:x.verifiedSlot,receivedAt:x.verifiedAt}));
  const verdict=validateLocalComponents(checks,now,this.opts.maxAgeMs,this.opts.maxSlotSkew);
  const slots=observations.map(x=>x.verifiedSlot);
  const slotGap=Math.max(...slots)-Math.min(...slots);
  if(!verdict.ok)return {ok:false,reason:verdict.reason,slotGap,
   oldestAgeMs:now-verdict.oldestAt};
  try{
   const sdk=entry.sdk;
   const acc=sdk.program.coder.accounts.decode('lbPair',observations[0].data) as typeof sdk.lbPair;
   if(acc.tokenXMint.toBase58()!==sdk.tokenX.publicKey.toBase58()||
      acc.tokenYMint.toBase58()!==sdk.tokenY.publicKey.toBase58())
    return {ok:false,reason:'pool_mints_changed'};
   for(const address of this.arrays(entry)){
    const obs=this.observed(address);
    if(!obs)return {ok:false,reason:'bin_array_missing:'+address};
    const bin=sdk.program.coder.accounts.decode('binArray',obs.data) as BinArrayAccount['account'];
    if(bin.lbPair.toBase58()!==entry.candidate.address)
     return {ok:false,reason:'bin_array_wrong_pool'};
   }
   return {ok:true,observedAt:verdict.oldestAt,
    poolSlot:observations[0].verifiedSlot,
    tickSlot:Math.min(...observations.slice(1).map(x=>x.verifiedSlot)),
    slotGap,oldestAgeMs:now-verdict.oldestAt};
  }catch(error){return {ok:false,reason:'dlmm_decode_error:'+message(error)}}
 }
 quote(address:string,inputMint:string,inputRaw:bigint,now=Date.now()):bigint|null{
  if(!this.running||inputRaw<=0n)return null;
  const entry=this.entries.get(address);if(!entry||!this.state(entry,now).ok)return null;
  try{
   const sdk=entry.sdk,fromX=sdk.lbPair.tokenXMint.toBase58()===inputMint;
   if(!fromX&&sdk.lbPair.tokenYMint.toBase58()!==inputMint)return null;
   // Decode verified account bytes into the official protocol model.
   const pool=this.observed(address);
   if(!pool)return null;
   sdk.lbPair=sdk.program.coder.accounts.decode('lbPair',pool.data) as typeof sdk.lbPair;
   const names=fromX?entry.binX:entry.binY;
   const bins=names.map(key=>{
    const data=this.observed(key);
    if(!data)throw Error('bin_array_missing');
    const account=sdk.program.coder.accounts.decode('binArray',data.data) as BinArrayAccount['account'];
    return {publicKey:new PublicKey(key),account};
   });
   // Both output and dynamic fees are calculated using Meteora's SDK.
   // Never allow an SDK partial fill to masquerade as a full exact input.
   const quote=sdk.swapQuote(new BN(inputRaw.toString()),fromX,new BN(0),bins,false);
   if(!quote.outAmount||quote.outAmount.lten(0))return null;
   if(quote.consumedInAmount.toString()!==inputRaw.toString())return null;
   entry.lastQuoteAt=new Date(now).toISOString();entry.quoteFailure=undefined;
   this.localQuotes++;
   return BigInt(quote.outAmount.toString());
  }catch(error){
   this.quoteFailures++;
   entry.quoteFailure=message(error);
   return null;
  }
 }
 graphPools(now=Date.now()):GraphPool[]{
  if(!this.running)return [];
  const result:GraphPool[]=[];
  for(const entry of this.entries.values()){
   const v=this.state(entry,now);
   if(!v.ok||!v.observedAt||v.poolSlot===undefined||v.tickSlot===undefined)continue;
   const a=assetOfMint(entry.sdk.lbPair.tokenXMint.toBase58());
   const b=assetOfMint(entry.sdk.lbPair.tokenYMint.toBase58());
   if(!a||!b)continue;
   const address=entry.candidate.address;
   result.push({
    address,program:'meteora_dlmm',tokenA:a,tokenB:b,
    reserveA:'0',reserveB:'0',feeNumerator:'0',feeDenominator:'1000000',
    observedAt:new Date(v.observedAt).toISOString(),poolSlot:v.poolSlot,
    vaultSlot:v.tickSlot,liquidityUsd:entry.candidate.liquidityUsd,
    snapshotIntegrity:'bounded_slot_research',
    quoteExactInput:(from,raw)=>{
     const mint=GRAPH_ASSETS[from]?.mint;
     return mint?this.quote(address,mint,raw):null;
    }
   });
  }
  return result;
 }
 snapshot(now=Date.now()):DlmmHealth{
  const perPool=this.candidates.map(c=>{
   const entry=this.entries.get(c.address);
   const value=entry?this.state(entry,now):{ok:false,reason:this.pending.has(c.address)?
    'bootstrapping_bin_arrays':'pool_not_prepared'};
   return {address:c.address,pair:assetOfMint(c.mintA)+'/'+assetOfMint(c.mintB),
    status:(value.ok?'ready':this.pending.has(c.address)?'warming':'not_ready') as DlmmPoolReadiness['status'],
    reason:value.ok?undefined:value.reason,binArrays:entry?this.arrays(entry).length:0,
    oldestAgeMs:'oldestAgeMs' in value?value.oldestAgeMs??null:null,
    slotGap:'slotGap' in value?value.slotGap??null:null,
    lastQuoteAt:entry?.lastQuoteAt};
  });
  return {status:this.status,tracked:this.candidates.length,
   ready:perPool.filter(x=>x.status==='ready').length,
   bootstrapAttempts:this.bootstrapAttempts,bootstrapFailures:this.bootstrapFailures,
   localQuotes:this.localQuotes,quoteFailures:this.quoteFailures,
   verifiedAccountRefreshes:this.verifiedAccountRefreshes,pending:this.pending.size,
   lastRefreshAt:this.lastRefreshAt,perPool,errors:[...this.errors]};
 }
 stop(){
  this.running=false;if(this.timer)clearInterval(this.timer);
  this.eventRelease?.();this.eventRelease=undefined;
  for(const key of [...this.entries.keys()])this.forget(key);
  this.candidates=[];this.status='stopped';
 }
}
