import {createHash} from 'node:crypto';
import {Connection,PublicKey,type AccountInfo} from '@solana/web3.js';
import type {Config} from './config.js';
import {Journal,type PoolEvent} from './store.js';
export type PoolState={address:string;slot:number;observedAt:string;source:'websocket'|'poll';owner:string;lamports:number;dataLength:number;dataHash:string};
export class Scanner{
 private conn:Connection;
 private journal:Journal;
 private state=new Map<string,PoolState>();
 private ids=new Map<string,number>();
 private timer?:ReturnType<typeof setInterval>;
 private running=false;
 private lastPollAt?:string;
 private errors=0;
 private pollInFlight=false;
 constructor(private readonly config:Config,connection?:Connection){
  this.conn=connection??new Connection(config.rpcUrl,{commitment:'confirmed',wsEndpoint:config.wsUrl});
  this.journal=new Journal(config.dataDir);
 }
 private async record(event:PoolEvent){
  try{await this.journal.append(event);}catch(error){this.errors++;console.error('Journal error',error);}
 }
 private async ingest(address:string,info:AccountInfo<Buffer>,slot:number,source:'poll'|'websocket'){
  const observedAt=new Date().toISOString();
  const dataHash=createHash('sha256').update(info.data).digest('hex');
  const prev=this.state.get(address);
  if(prev&&(slot<prev.slot||(slot===prev.slot&&dataHash===prev.dataHash)))return;
  const next={address,slot,observedAt,source,owner:info.owner.toBase58(),lamports:info.lamports,dataLength:info.data.length,dataHash};
  this.state.set(address,next);
  await this.record({kind:'account_update',...next});
  if(process.env.LOG_ACCOUNT_UPDATES==='1')console.log(JSON.stringify({event:'account_update',address,slot,source}));
 }
 private async poll(){
  if(!this.running||this.pollInFlight)return;
  this.pollInFlight=true;
  try{
   const result=await this.conn.getMultipleAccountsInfoAndContext(this.config.pools,'confirmed');
   this.lastPollAt=new Date().toISOString();
   await Promise.all(result.value.map(async(info,index)=>{
    const address=this.config.pools[index].toBase58();
    if(info)await this.ingest(address,info,result.context.slot,'poll');
    else await this.record({kind:'account_missing',address,source:'poll',observedAt:new Date().toISOString(),slot:result.context.slot});
   }));
  }catch(error){
   this.errors++;
   await this.record({kind:'poll_error',address:'*',source:'system',observedAt:new Date().toISOString(),error:String(error)});
   console.error('RPC poll failed',error);
  }finally{this.pollInFlight=false;}
 }
 private async subscribe(pool:PublicKey){
  const address=pool.toBase58();
  if(this.ids.has(address))return;
  try{
   const id=this.conn.onAccountChange(pool,(info,context)=>{
    void this.ingest(address,info,context.slot,'websocket').catch(e=>{this.errors++;console.error('WS ingest error',e);});
   },'confirmed');
   this.ids.set(address,id);
  }catch(error){
   this.errors++;
   await this.record({kind:'subscription_error',address,source:'system',observedAt:new Date().toISOString(),error:String(error)});
  }
 }
 async replacePools(next:PublicKey[]){
  const addresses=new Set(next.map(k=>k.toBase58()));
  if(this.running){
   // Subscribe newly discovered pools before removing obsolete subscriptions.
   for(const pool of next)await this.subscribe(pool);
   for(const [address,id] of this.ids){
    if(addresses.has(address))continue;
    this.ids.delete(address);
    this.state.delete(address);
    try{await this.conn.removeAccountChangeListener(id);}
    catch(error){this.errors++;console.error('WS unsubscribe error',error);}
   }
  }
  this.config.pools=[...next];
 }
 async start(){
  if(this.running)return;
  this.running=true;
  for(const pool of this.config.pools)await this.subscribe(pool);
  await this.poll();
  this.timer=setInterval(()=>{void this.poll();},this.config.pollIntervalMs);
 }
 snapshot(){
  const now=Date.now();
  const pools=this.config.pools.map(pool=>{
   const address=pool.toBase58(),state=this.state.get(address);
   const ageMs=state?now-Date.parse(state.observedAt):null;
   return {address,...state,ageMs,stale:ageMs===null||ageMs>this.config.staleAfterMs};
  });
  return {status:!this.running?'stopped':pools.some(p=>p.stale)?'degraded':'healthy',lastPollAt:this.lastPollAt,errors:this.errors,pools};
 }
 async stop(){
  this.running=false;
  if(this.timer)clearInterval(this.timer);
  await Promise.allSettled([...this.ids.values()].map(id=>this.conn.removeAccountChangeListener(id)));
  this.ids=[];
 }
}
