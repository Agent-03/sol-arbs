import {createHash} from 'node:crypto';
import {Connection,PublicKey,type AccountInfo} from '@solana/web3.js';

export type MarketSource='websocket'|'rpc_poll'|'rpc_reconcile'|'rpc_bootstrap'|'geyser';
export type MarketObservation={
 address:string; owner:string; data:Buffer; lamports:number; executable:boolean; rentEpoch:number;
 slot:number; receivedAt:number;
 source:MarketSource; hash:string; verifiedAt:number;
};
export type MarketUpdate=MarketObservation&{affectedPools:string[]};
export type MarketHealth={
 mode:'websocket_account_cache';trackedAccounts:number;watchedAccounts:number;
 poolDependencies:number;readyPools:number;stalePools:number;
 missingDependencies:number;slotSkewPools:number;
 updates:number;wsUpdates:number;rpcUpdates:number;geyserUpdates:number;
 duplicateUpdates:number;olderSlotDrops:number;ownerMismatchDrops:number;
 lastReceivedAt?:string;lastStreamReceivedAt?:string;
 errors:string[];
 pools:Array<{pool:string;accounts:number;present:number;oldestAgeMs:number|null;
  minSlot:number|null;maxSlot:number|null;slotSkew:number|null;
  state:'ready'|'missing'|'stale'|'slot_skew';}> ;
};

/** Shared, read-only, slot-monotone account feed. No transaction handling.
 * One WebSocket subscription per address, regardless of watch consumers.
 * Dependencies are account public keys; a changed vault only invalidates
 * pools that actually depend on that vault. Geyser-ready ingestion API
 * accepts normalized messages but does NOT itself connect to Geyser.
 */
export class MarketDataFeed{
 private accounts=new Map<string,MarketObservation>();
 private subscriptions=new Map<string,{id:number;count:number}>();
 private expectedOwners=new Map<string,string>();
 private poolDeps=new Map<string,Set<string>>();
 private reverseDeps=new Map<string,Set<string>>();
 private listeners=new Set<(update:MarketUpdate)=>void>();
 private errors:string[]=[];
 private updates=0;private wsUpdates=0;private rpcUpdates=0;private geyserUpdates=0;
 private duplicateUpdates=0;private olderSlotDrops=0;private ownerMismatchDrops=0;
 private lastReceivedAt?:string;private lastStreamReceivedAt?:string;
 private stopped=false;
 constructor(private readonly connection:Connection,
  private readonly maxAgeMs=15000,private readonly maxSlotSkew=12){
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<=0||
     !Number.isSafeInteger(maxSlotSkew)||maxSlotSkew<0)throw new Error('Invalid market data thresholds');
 }
 onUpdate(listener:(update:MarketUpdate)=>void):()=>void{
  this.listeners.add(listener);return ()=>this.listeners.delete(listener);
 }
 expectOwner(address:string,owner:string){
  const previous=this.expectedOwners.get(address);
  if(previous&&previous!==owner)throw new Error('Conflicting owner for '+address);
  this.expectedOwners.set(address,owner);
  const prior=this.accounts.get(address);
  if(prior&&prior.owner!==owner){this.ownerMismatchDrops++;this.accounts.delete(address);}
 }
 setDependencies(pool:string,addresses:readonly string[]){
  this.clearDependencies(pool);
  const deps=new Set(addresses);
  if(!deps.size)return;
  this.poolDeps.set(pool,deps);
  for(const address of deps){
   const owners=this.reverseDeps.get(address)??new Set<string>();
   owners.add(pool);this.reverseDeps.set(address,owners);
  }
 }
 hasDependencies(pool:string):boolean{return this.poolDeps.has(pool);}
 clearDependencies(pool:string){
  const previous=this.poolDeps.get(pool);
  if(!previous)return;
  for(const address of previous){
   const pools=this.reverseDeps.get(address);
   pools?.delete(pool);
   if(!pools?.size)this.reverseDeps.delete(address);
  }
  this.poolDeps.delete(pool);
 }
 get(address:string):MarketObservation|undefined{
  const value=this.accounts.get(address);
  return value?{...value,data:Buffer.from(value.data)}:undefined;
 }
 getPool(pool:string){return [...(this.poolDeps.get(pool)??[])].map(addr=>this.get(addr));}
 ingest(address:string,info:AccountInfo<Buffer>,slot:number,source:MarketSource,
   receivedAt=Date.now()):boolean{
  if(this.stopped||!Number.isSafeInteger(slot)||slot<0||
   !Number.isFinite(receivedAt))return false;
  const owner=info.owner.toBase58();
  const expected=this.expectedOwners.get(address);
  if(expected&&expected!==owner){this.ownerMismatchDrops++;return false;}
  const data=Buffer.from(info.data);
  const hash=createHash('sha256').update(data).digest('hex');
  const existing=this.accounts.get(address);
  if(existing){
   if(slot<existing.slot){this.olderSlotDrops++;return false;}
   if(slot===existing.slot&&hash===existing.hash&&owner===existing.owner){
    // A repeated RPC read may validate an old observation; it does not
    // turn that observation into a newer market update.
    existing.verifiedAt=receivedAt;
    this.duplicateUpdates++;return false;
   }
   // Equal-slot RPC must not clobber a WebSocket/Geyser notification.
   if(slot===existing.slot&&source!=='websocket'&&source!=='geyser'&&
     (existing.source==='websocket'||existing.source==='geyser')){
    this.olderSlotDrops++;return false;
   }
  }
  const value:MarketObservation={address,owner,data,lamports:info.lamports,executable:info.executable,
   rentEpoch:info.rentEpoch,slot,source,receivedAt,hash,verifiedAt:receivedAt};
  this.accounts.set(address,value);
  this.updates++;
  if(source==='websocket')this.wsUpdates++;
  else if(source==='geyser')this.geyserUpdates++;
  else this.rpcUpdates++;
  this.lastReceivedAt=new Date(receivedAt).toISOString();
  if(source==='websocket'||source==='geyser')this.lastStreamReceivedAt=this.lastReceivedAt;
  const event:MarketUpdate={...value,data:Buffer.from(value.data),
   affectedPools:[...(this.reverseDeps.get(address)??[])].sort()};
  for(const listener of this.listeners){
   try{listener(event);}catch(error){this.addError('Account listener: '+String(error));}
  }
  return true;
 }
 private addError(message:string){
  this.errors.unshift(message);this.errors=this.errors.slice(0,8);
 }
 /** Deduplicated live watch; registered before any caller's RPC bootstrap. */
 watch(address:string):()=>void{
  if(this.stopped)throw new Error('Market data feed stopped');
  const known=this.subscriptions.get(address);
  if(known){known.count++;let released=false;return ()=>{if(released)return;released=true;this.unwatch(address);};}
  const key=new PublicKey(address);
  const id=this.connection.onAccountChange(key,(info,context)=>{
   this.ingest(address,info,context.slot,'websocket',Date.now());
  },'confirmed');
  this.subscriptions.set(address,{id,count:1});
  let released=false;
  return ()=>{if(released)return;released=true;this.unwatch(address);};
 }
 private unwatch(address:string){
  const sub=this.subscriptions.get(address);
  if(!sub)return;
  sub.count--;
  if(sub.count>0)return;
  this.subscriptions.delete(address);
  void this.connection.removeAccountChangeListener(sub.id).catch(error=>{
   this.addError('Unsubscribe failed for '+address+': '+String(error));
  });
 }
 /** One RPC context per chunk, never treating different chunks as same-slot. */
 async reconcile(addresses:readonly string[],source:'rpc_poll'|'rpc_reconcile'|'rpc_bootstrap'='rpc_reconcile'){
  const distinct=[...new Set(addresses)];
  for(let offset=0;offset<distinct.length;offset+=75){
   const batch=distinct.slice(offset,offset+75);
   const values=await this.connection.getMultipleAccountsInfoAndContext(
    batch.map(address=>new PublicKey(address)),'confirmed');
   const at=Date.now();
   values.value.forEach((info,i)=>{
    if(info)this.ingest(batch[i],info,values.context.slot,source,at);
    else this.addError('Missing account '+batch[i]+' at slot '+values.context.slot);
   });
  }
 }
 snapshot(now=Date.now()):MarketHealth{
  const pools=[...this.poolDeps.entries()].map(([pool,deps])=>{
   const values=[...deps].map(address=>this.accounts.get(address));
   const present=values.filter((a):a is MarketObservation=>Boolean(a));
   const slots=present.map(a=>a.slot),minSlot=slots.length?Math.min(...slots):null,
    maxSlot=slots.length?Math.max(...slots):null;
   const slotSkew=minSlot===null||maxSlot===null?null:maxSlot-minSlot;
   const oldestAgeMs=present.length?Math.max(...present.map(a=>Math.max(0,now-a.receivedAt))):null;
   const state:MarketHealth['pools'][number]['state']=
    present.length!==deps.size?'missing':oldestAgeMs!==null&&oldestAgeMs>this.maxAgeMs?'stale':
    slotSkew!==null&&slotSkew>this.maxSlotSkew?'slot_skew':'ready';
   return {pool,accounts:deps.size,present:present.length,oldestAgeMs,
    minSlot,maxSlot,slotSkew,state};
  });
  return {mode:'websocket_account_cache',trackedAccounts:this.accounts.size,
   watchedAccounts:this.subscriptions.size,poolDependencies:pools.length,
   readyPools:pools.filter(p=>p.state==='ready').length,
   stalePools:pools.filter(p=>p.state==='stale').length,
   missingDependencies:pools.filter(p=>p.state==='missing').length,
   slotSkewPools:pools.filter(p=>p.state==='slot_skew').length,
   updates:this.updates,wsUpdates:this.wsUpdates,rpcUpdates:this.rpcUpdates,
   geyserUpdates:this.geyserUpdates,duplicateUpdates:this.duplicateUpdates,
   olderSlotDrops:this.olderSlotDrops,ownerMismatchDrops:this.ownerMismatchDrops,
   lastReceivedAt:this.lastReceivedAt,lastStreamReceivedAt:this.lastStreamReceivedAt,
   errors:[...this.errors],pools};
 }
 async stop(){
  this.stopped=true;this.listeners.clear();this.poolDeps.clear();this.reverseDeps.clear();
  const listeners=[...this.subscriptions.values()];
  this.subscriptions.clear();
  await Promise.allSettled(listeners.map(s=>this.connection.removeAccountChangeListener(s.id)));
 }
}
