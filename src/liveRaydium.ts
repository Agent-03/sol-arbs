import {Connection,PublicKey,type AccountInfo} from '@solana/web3.js';
import {decodeAmmV4,decodeVault,quoteV4,type AmmV4State,type AmmV4Quote} from './ammV4.js';
import {SOL_MINT,USDC_MINT,type DiscoveredPool} from './discovery.js';
import {RAYDIUM_AMM_V4} from './routes.js';
import type {MarketDataFeed} from './marketData.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const AMM_AUTHORITY=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();

type Component={data:Buffer;slot:number;receivedAt:number};
type WatchedPool={
 address:string;
 vaults:[string,string];
 components:Map<string,Component>;
 ids:number[];
 releases:(()=>void)[];
 reason?:string;
};
export type LiveRaydiumEvent={
 pool:string;slot:number;receivedAt:number;source:'websocket'|'reconcile';
 ready:boolean;reason?:string;
};
export type LiveRaydiumSnapshot={
 status:'idle'|'bootstrapping'|'ok'|'degraded'|'stopped';
 poolCount:number;readyPools:number;subscriptions:number;events:number;
 localRecomputations:number;reconciliations:number;lastUpdateAt?:string;
 quotes:AmmV4Quote[];errors:string[];poolReasons:Record<string,string>;
 lastUpdatedAt?:string;progress:{totalPools:number;completedPools:number;quotesProduced:number};
};

/**
 * Phase B5 Raydium AMM v4 research monitor.
 *
 * Performs a coherent-context triple account read to bootstrap/reconcile,
 * then updates an in-memory quote book directly from WebSocket pool/vault
 * notifications (no HTTP RPC request on the event hot path).
 *
 * IMPORTANT: Raydium v4 AMM vault-only CPMM math does not reconcile
 * OpenBook open orders. These outputs remain APPROXIMATE, not executable.
 */
export class LiveRaydiumMonitor{
 private watched=new Map<string,WatchedPool>();
 private feedListener?:()=>void;
 private lastAttachAttempts=new Map<string,number>();
 private quotes=new Map<string,AmmV4Quote[]>();
 private errors:string[]=[];
 private running=false;
 private bootstrapping=false;
 private reconciling=false;
 private timer?:ReturnType<typeof setInterval>;
 private events=0;
 private localRecomputations=0;
 private reconciliations=0;
 private lastUpdateAt?:string;
 private completedPools=0;
 constructor(
  private readonly connection:Connection,
  private readonly pools:DiscoveredPool[],
  private readonly sizesUsd:number[],
  private readonly maxSlotSkew:number,
  private readonly maxAccountAgeMs:number,
  private readonly minLiquidityUsd:number,
  private readonly reconciliationMs:number,
  private readonly onEvent:(event:LiveRaydiumEvent)=>void,
  private readonly feed?:MarketDataFeed
 ){}
 private supported():DiscoveredPool[]{
  return this.pools.filter(p=>p.owner===RAYDIUM_AMM_V4&&
   (p.venue==='raydium'||p.venue==='manual')&&
   (p.liquidityUsd===undefined||p.liquidityUsd>=this.minLiquidityUsd));
 }
 private error(message:string){
  this.errors.unshift(message);this.errors=this.errors.slice(0,12);
 }
 private async remove(pool:WatchedPool){
  this.watched.delete(pool.address);
  this.quotes.delete(pool.address);
  for(const release of pool.releases)release();
  this.feed?.clearDependencies(pool.address);
  await Promise.allSettled(pool.ids.map(id=>this.connection.removeAccountChangeListener(id)));
 }
 private setComponent(pool:WatchedPool,address:string,info:AccountInfo<Buffer>,slot:number,source:'websocket'|'reconcile',receivedAt=Date.now()){
  const existing=pool.components.get(address);
  if(existing&&slot<existing.slot)return;
  if(existing&&slot===existing.slot&&existing.data.equals(info.data))return;
  const isPool=address===pool.address;
  try{
   if(isPool){
    if(info.owner.toBase58()!==RAYDIUM_AMM_V4)throw new Error('pool owner changed');
    const decoded=decodeAmmV4(pool.address,info.data);
    if(decoded.baseVault!==pool.vaults[0]||decoded.quoteVault!==pool.vaults[1]){
     throw new Error('vault addresses changed: rebootstrap required');
    }
   }else{
    if(info.owner.toBase58()!==TOKEN_PROGRAM)throw new Error('vault owner changed');
    const mint=this.mintOf(pool,address);
    decodeVault(info.data,mint,AMM_AUTHORITY);
   }
  }catch(error){
   pool.reason=String(error);
   pool.components.delete(address);
   this.quotes.delete(pool.address);
   this.error(pool.address+': '+String(error));
   this.notify(pool,slot,receivedAt,source);
   return;
  }
  // Equal-slot notifications may carry fresher data after a reconnect.
  pool.components.set(address,{data:Buffer.from(info.data),slot,receivedAt});
  pool.reason=undefined;
  if(source==='websocket')this.events++;
  this.recompute(pool,slot,receivedAt,source);
 }
 private mintOf(pool:WatchedPool,vault:string):string{
  const primary=pool.components.get(pool.address);
  if(!primary)throw new Error('pool state not initialized');
  const state=decodeAmmV4(pool.address,primary.data);
  return pool.vaults[0]===vault?state.baseMint:state.quoteMint;
 }
 private notify(pool:WatchedPool,slot:number,receivedAt:number,source:'websocket'|'reconcile'){
  this.lastUpdateAt=new Date(receivedAt).toISOString();
  try{this.onEvent({pool:pool.address,slot,receivedAt,source,
   ready:this.quotes.has(pool.address),reason:pool.reason});}
  catch(error){this.error('evaluation callback failed: '+String(error));}
 }
 private recompute(pool:WatchedPool,slot:number,receivedAt:number,source:'websocket'|'reconcile'){
  this.localRecomputations++;
  const primary=pool.components.get(pool.address);
  const base=pool.components.get(pool.vaults[0]);
  const quote=pool.components.get(pool.vaults[1]);
  if(!primary||!base||!quote){
   pool.reason='waiting_for_all_pool_and_vault_accounts';
   this.quotes.delete(pool.address);
   this.notify(pool,slot,receivedAt,source);return;
  }
  const slots=[primary.slot,base.slot,quote.slot];
  const gap=Math.max(...slots)-Math.min(...slots);
  const age=receivedAt-Math.min(primary.receivedAt,base.receivedAt,quote.receivedAt);
  if(gap>this.maxSlotSkew||age>this.maxAccountAgeMs){
   pool.reason=gap>this.maxSlotSkew?'component_slot_skew':'component_age_exceeded';
   this.quotes.delete(pool.address);
   this.notify(pool,slot,receivedAt,source);return;
  }
  try{
   const state:AmmV4State=decodeAmmV4(pool.address,primary.data);
   const baseAmount=decodeVault(base.data,state.baseMint,AMM_AUTHORITY);
   const quoteAmount=decodeVault(quote.data,state.quoteMint,AMM_AUTHORITY);
   // Use the OLDEST component receipt time, not the latest callback time.
   // Recomputing after one vault changes must never make other cached
   // components appear fresher than they really are.
   const oldestReceivedAt=new Date(Math.min(
    primary.receivedAt,base.receivedAt,quote.receivedAt)).toISOString();
   const next:AmmV4Quote[]=this.sizesUsd.map(size=>({
    ...quoteV4(state,baseAmount,quoteAmount,BigInt(Math.round(size*1e6)),
     primary.slot,Math.min(base.slot,quote.slot)),
    observedAt:oldestReceivedAt
   }));
   this.quotes.set(pool.address,next);
   pool.reason=undefined;
  }catch(error){
   pool.reason=String(error);
   this.error(pool.address+': '+String(error));
   this.quotes.delete(pool.address);
  }
  this.notify(pool,slot,receivedAt,source);
 }
 private async attach(source:DiscoveredPool){
  if(!this.running||this.watched.has(source.address))return;
  this.lastAttachAttempts.set(source.address,Date.now());
  const key=new PublicKey(source.address);
  const account=await this.connection.getAccountInfoAndContext(key,'confirmed');
  if(!account.value||account.value.owner.toBase58()!==RAYDIUM_AMM_V4)
   throw new Error('invalid Raydium AMM owner for '+source.address);
  const state=decodeAmmV4(source.address,account.value.data);
  const pool:WatchedPool={address:source.address,vaults:[state.baseVault,state.quoteVault],
   components:new Map(),ids:[],releases:[]};
  this.watched.set(source.address,pool);
  const addresses=[pool.address,...pool.vaults];
  try{
   if(this.feed){
    this.feed.expectOwner(pool.address,RAYDIUM_AMM_V4);
    for(const address of pool.vaults)this.feed.expectOwner(address,TOKEN_PROGRAM);
    this.feed.setDependencies(pool.address,addresses);
   }
   for(const address of addresses){
    if(this.feed){
     pool.releases.push(this.feed.watch(address));
     continue;
    }
    const id=this.connection.onAccountChange(new PublicKey(address),(info,context)=>{
     if(!this.running||this.watched.get(pool.address)!==pool)return;
     this.setComponent(pool,address,info,context.slot,'websocket',Date.now());
    },'confirmed');
    pool.ids.push(id);
   }
   // After subscriptions are registered, reconcile the three accounts
   // with ONE context slot. No missing notifications between subscribe/read.
   await this.reconcilePool(pool);
  }catch(error){
   await this.remove(pool);throw error;
  }
 }
 private async reconcilePool(pool:WatchedPool){
  const keys=[new PublicKey(pool.address),...pool.vaults.map(v=>new PublicKey(v))];
  const result=await this.connection.getMultipleAccountsInfoAndContext(keys,'confirmed');
  if(!this.running||this.watched.get(pool.address)!==pool)return;
  if(result.value.some(a=>a===null))throw new Error('pool/vault account missing');
  const receivedAt=Date.now();
  // Validate ALL three before committing any data; the same RPC context
  // is the only way to avoid treating separately-fetched slots as one snapshot.
  const accounts=result.value as AccountInfo<Buffer>[];
  const state=decodeAmmV4(pool.address,accounts[0].data);
  if(accounts[0].owner.toBase58()!==RAYDIUM_AMM_V4||state.baseVault!==pool.vaults[0]||state.quoteVault!==pool.vaults[1])
   throw new Error('Raydium pool owner/vault mismatch');
  for(let i=1;i<3;i++){
   if(accounts[i].owner.toBase58()!==TOKEN_PROGRAM)throw new Error('vault program mismatch');
   decodeVault(accounts[i].data,i===1?state.baseMint:state.quoteMint,AMM_AUTHORITY);
  }
  // Do not overwrite a newer WebSocket notification with older RPC data.
  for(let i=0;i<3;i++){
   const address=keys[i].toBase58();
   const previous=pool.components.get(address);
   if(previous&&previous.slot>result.context.slot)continue;
   pool.components.set(address,{data:Buffer.from(accounts[i].data),slot:result.context.slot,receivedAt});
  }
  this.reconciliations++;
  // Reconciliation is atomic per RPC context for this three-account set.
  // Send observations to the shared cache; same-slot duplicate reads do
  // not advance its market-data timestamp.
  if(this.feed){
   for(let i=0;i<3;i++)this.feed.ingest(keys[i].toBase58(),accounts[i],
    result.context.slot,'rpc_reconcile',receivedAt);
  }
  this.recompute(pool,result.context.slot,receivedAt,'reconcile');
 }
 async start(){
  if(this.running)return;
  this.running=true;this.bootstrapping=true;
  if(this.feed)this.feedListener=this.feed.onUpdate(update=>{
   if(!this.running)return;
   for(const poolId of update.affectedPools){
    const pool=this.watched.get(poolId);
    if(!pool||![pool.address,...pool.vaults].includes(update.address))continue;
    const info:AccountInfo<Buffer>={
     data:Buffer.from(update.data),owner:new PublicKey(update.owner),
     lamports:0,executable:false,rentEpoch:0
    };
    this.setComponent(pool,update.address,info,update.slot,
     update.source==='websocket'||update.source==='geyser'?'websocket':'reconcile',
     update.receivedAt);
   }
  });
  const sources=this.supported();
  for(const source of sources){
   if(!this.running)break;
   try{await this.attach(source);}catch(error){this.error(source.address+': '+String(error));}
   this.completedPools++;
  }
  this.bootstrapping=false;
  if(this.running)this.timer=setInterval(()=>{void this.reconcileAll();},this.reconciliationMs);
 }
 async reconcileAll(){
  if(!this.running||this.reconciling)return;
  this.reconciling=true;
  try{
   for(const pool of this.watched.values()){
    if(!this.running)break;
    try{await this.reconcilePool(pool);}
    catch(error){
     pool.reason='reconciliation_failed';
     this.quotes.delete(pool.address);
     this.error(pool.address+': '+String(error));
     this.notify(pool,0,Date.now(),'reconcile');
    }
   }
   // Transient bootstrap failures must not permanently remove a quoteable
   // pool. Retry missing subscriptions no more than once every 60 seconds.
   for(const source of this.supported()){
    if(!this.running)break;
    if(this.watched.has(source.address))continue;
    if(Date.now()-(this.lastAttachAttempts.get(source.address)??0)<60000)continue;
    try{await this.attach(source);}
    catch(error){this.error(source.address+': reattach failed: '+String(error));}
   }
  }finally{this.reconciling=false;}
 }
 async replacePools(){
  const selected=this.supported();
  const wanted=new Set(selected.map(p=>p.address));
  for(const pool of [...this.watched.values()])if(!wanted.has(pool.address))await this.remove(pool);
  for(const source of selected)if(!this.watched.has(source.address)){
   try{await this.attach(source);}catch(error){this.error(source.address+': '+String(error));}
  }
 }
 snapshot():LiveRaydiumSnapshot{
  const sources=this.supported();
  const reasons:Record<string,string>={};
  const now=Date.now();
  for(const source of sources){
   const p=this.watched.get(source.address);
   if(!p)reasons[source.address]='not_subscribed_or_bootstrap_failed';
   else if(p.reason)reasons[source.address]=p.reason;
   else if(!this.quotes.has(source.address))reasons[source.address]='not_ready';
   else if([...p.components.values()].some(part=>now-part.receivedAt>this.maxAccountAgeMs))
    reasons[source.address]='component_age_exceeded';
  }
  const valid=new Set(sources.map(p=>p.address).filter(addr=>!reasons[addr]));
  const quotes=[...this.quotes.entries()].filter(([pool])=>valid.has(pool)).flatMap(([,rows])=>rows);
  return {status:!this.running?'stopped':this.bootstrapping?'bootstrapping':
   Object.keys(reasons).length?'degraded':'ok',
   poolCount:sources.length,readyPools:valid.size,
   subscriptions:[...this.watched.values()].reduce((sum,p)=>sum+p.ids.length+p.releases.length,0),
   events:this.events,localRecomputations:this.localRecomputations,
   reconciliations:this.reconciliations,lastUpdateAt:this.lastUpdateAt,
   quotes,errors:[...this.errors],poolReasons:reasons,
   lastUpdatedAt:this.lastUpdateAt,
   progress:{totalPools:sources.length,completedPools:this.completedPools,quotesProduced:quotes.length}};
 }
 async stop(){
  this.running=false;
  if(this.timer)clearInterval(this.timer);
  this.feedListener?.();this.feedListener=undefined;
  for(const pool of [...this.watched.values()])await this.remove(pool);
 }
}
