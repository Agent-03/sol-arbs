import {currentRpcContext,type RpcPriority,type RpcTiming} from './rpcPriority.js';

/**
 * Single-flight, shared Solana HTTP RPC limiter.
 *
 * All web3.js / Anchor / Whirlpool requests must use the same Connection
 * configured with this fetch function. This deliberately favors reliable,
 * read-only diagnostics over low-latency trading.
 */
export type RpcLimitOptions={
 minSpacingMs:number;
 maxConcurrent?:number;
 backgroundMaxConcurrent?:number;
 maxRetries:number;
 initialBackoffMs:number;
 maxBackoffMs:number;
};
export type RpcLimitSnapshot={
 calls:number;
 attempts:number;
 rateLimits:number;
 retryAttempts:number;
 transportErrors:number;
 last429At?:string;
 cooldownUntil?:string;
 minSpacingMs:number;
 maxConcurrent:number;
 inFlight:number;
 pending:number;
 queued:boolean;
 backgroundMaxConcurrent:number;
 pendingByPriority:Record<RpcPriority,number>;
 inFlightByPriority:Record<RpcPriority,number>;
 oldestQueuedMs:number;
 queueWaitMsAvg:Record<RpcPriority,number>;
 queueWaitMsP95:Record<RpcPriority,number>;
 transportMsAvg:Record<RpcPriority,number>;
 transportMsP95:Record<RpcPriority,number>;
 priorityDispatches:Record<RpcPriority,number>;
};

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function parseRetryAfterMs(value:string|null,now=Date.now()):number|null {
 if(!value)return null;
 const seconds=Number(value.trim());
 if(Number.isFinite(seconds)&&seconds>=0)return Math.round(seconds*1000);
 const date=Date.parse(value);
 return Number.isFinite(date)?Math.max(0,date-now):null;
}

type Waiter={priority:RpcPriority;queuedAt:number;resolve:()=>void};
const levels:RpcPriority[]=['quotes','normal','background'];
const counts=():Record<RpcPriority,number>=>({quotes:0,normal:0,background:0});
const values=():Record<RpcPriority,number[]>=>({quotes:[],normal:[],background:[]});
const mean=(arr:readonly number[])=>arr.length?
 Math.round(arr.reduce((a,b)=>a+b,0)/arr.length):0;
const p95=(arr:readonly number[])=>arr.length?
 [...arr].sort((a,b)=>a-b)[Math.ceil(arr.length*0.95)-1]:0;

export class RpcHttpLimiter {
 private pacing:Promise<void>=Promise.resolve();
 private readonly capacity:number;
 private readonly backgroundCapacity:number;
 private waiters:Waiter[]=[];
 private running=0;
 private readonly active=counts();
 private readonly dispatches=counts();
 private readonly queueWaits=values();
 private readonly transportTimes=values();
 private highStreak=0;
 private lastAttemptAt=0;
 private cooldownUntil=0;
 private calls=0;
 private attempts=0;
 private rateLimits=0;
 private retryAttempts=0;
 private transportErrors=0;
 private last429At?:string;

 constructor(private readonly options:RpcLimitOptions,private readonly transport:typeof fetch=globalThis.fetch){
  this.capacity=options.maxConcurrent??1;
  this.backgroundCapacity=options.backgroundMaxConcurrent??1;
  if(!Number.isSafeInteger(this.backgroundCapacity)||this.backgroundCapacity<1||
     this.backgroundCapacity>this.capacity||
     !Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>16||
     !Number.isSafeInteger(options.minSpacingMs)||options.minSpacingMs<0||
     !Number.isSafeInteger(options.maxRetries)||options.maxRetries<0||options.maxRetries>5||
     !Number.isSafeInteger(options.initialBackoffMs)||options.initialBackoffMs<1||
     !Number.isSafeInteger(options.maxBackoffMs)||options.maxBackoffMs<options.initialBackoffMs){
   throw new Error('Invalid RPC limiter configuration');
  }
 }
 snapshot():RpcLimitSnapshot{
  const pending=counts();
  for(const waiter of this.waiters)pending[waiter.priority]++;
  const sample=(rows:Record<RpcPriority,number[]>,fn:(xs:number[])=>number)=>{
   const result=counts();for(const level of levels)result[level]=fn(rows[level]);
   return result;
  };
  return {calls:this.calls,attempts:this.attempts,rateLimits:this.rateLimits,
   retryAttempts:this.retryAttempts,transportErrors:this.transportErrors,
   last429At:this.last429At,
   cooldownUntil:this.cooldownUntil>Date.now()?new Date(this.cooldownUntil).toISOString():undefined,
   minSpacingMs:this.options.minSpacingMs,maxConcurrent:this.capacity,
   backgroundMaxConcurrent:this.backgroundCapacity,
   inFlight:this.running,pending:this.waiters.length,queued:this.waiters.length>0,
   pendingByPriority:pending,inFlightByPriority:{...this.active},
   oldestQueuedMs:this.waiters.length?
    Math.max(...this.waiters.map(w=>Date.now()-w.queuedAt)):0,
   queueWaitMsAvg:sample(this.queueWaits,mean),queueWaitMsP95:sample(this.queueWaits,p95),
   transportMsAvg:sample(this.transportTimes,mean),
   transportMsP95:sample(this.transportTimes,p95),
   priorityDispatches:{...this.dispatches}};
 }
 private canRun(priority:RpcPriority){
  return this.running<this.capacity&&
   (priority!=='background'||this.active.background<this.backgroundCapacity);
 }
 private takeSlot(priority:RpcPriority){
  this.running++;this.active[priority]++;this.dispatches[priority]++;
  this.highStreak=priority==='quotes'?this.highStreak+1:0;
 }
 private drain(){
  while(this.running<this.capacity){
   const now=Date.now();
   const available=this.waiters.filter(w=>this.canRun(w.priority));
   if(!available.length)break;
   // Quotes leapfrog low-value SDK bootstrap and discovery. An old queued
   // request is occasionally admitted after a bounded critical streak so
   // continuous quote traffic cannot permanently starve other work.
   const aged=available.filter(w=>now-w.queuedAt>=8000);
   const next=aged.length&&this.highStreak>=6?
    aged[0]:levels.flatMap(level=>available.filter(w=>w.priority===level))[0];
   const index=this.waiters.indexOf(next);
   if(index<0)break;
   this.waiters.splice(index,1);
   this.takeSlot(next.priority);
   next.resolve();
  }
 }
 private record(rows:Record<RpcPriority,number[]>,priority:RpcPriority,duration:number){
  const values=rows[priority];values.push(Math.max(0,Math.round(duration)));
  if(values.length>128)values.shift();
 }
 private async acquire(priority:RpcPriority):Promise<number>{
  const queuedAt=Date.now();
  if(this.waiters.length===0&&this.canRun(priority))this.takeSlot(priority);
  else await new Promise<void>(resolve=>{
   this.waiters.push({priority,queuedAt,resolve});this.drain();
  });
  const duration=Date.now()-queuedAt;
  this.record(this.queueWaits,priority,duration);
  return duration;
 }
 private async exclusive<T>(priority:RpcPriority,
  onTiming:((event:RpcTiming)=>void)|undefined,
  action:()=>Promise<T>):Promise<T>{
  const waited=await this.acquire(priority);
  // Only pace request initiation, not network time.
  const previous=this.pacing;
  let releasePacing!:()=>void;
  this.pacing=new Promise<void>(resolve=>{releasePacing=resolve});
  await previous;
  try{
   const until=Math.max(this.cooldownUntil,this.lastAttemptAt+this.options.minSpacingMs);
   if(until>Date.now())await sleep(until-Date.now());
   this.lastAttemptAt=Date.now();
  }finally{releasePacing()}
  const started=Date.now();
  try{
   onTiming?.({phase:'started',priority,queueWaitMs:waited});
   return await action();
  }finally{
   const duration=Date.now()-started;
   this.record(this.transportTimes,priority,duration);
   this.active[priority]--;this.running--;this.drain();
  }
 }
 readonly fetch:typeof globalThis.fetch=async (input,init)=>{
  const context=currentRpcContext(),priority=context.priority;
  this.calls++;
  for(let attempt=0;attempt<=this.options.maxRetries;attempt++){
   // Capture 429 and establish the shared cooldown *before* allowing
   // the next queued RPC call to start.
   const response=await this.exclusive(priority,context.onTiming,async()=>{
    this.attempts++;
    let received:Response;
    const started=Date.now();
    try{received=await this.transport(input,init);}
    catch(error){
     this.transportErrors++;
     context.onTiming?.({phase:'completed',priority,queueWaitMs:0,
      transportMs:Date.now()-started});
     throw error;
    }
    context.onTiming?.({phase:'completed',priority,queueWaitMs:0,
     transportMs:Date.now()-started,status:received.status});
    if(received.status===429){
     this.rateLimits++;
     this.last429At=new Date().toISOString();
     const retryAfter=parseRetryAfterMs(received.headers.get('retry-after'));
     const exponential=Math.min(this.options.maxBackoffMs,this.options.initialBackoffMs*(2**attempt));
     const delay=Math.max(exponential,retryAfter??0);
     this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+delay);
    }
    return received;
   });
   if(response.status!==429)return response;
   if(attempt===this.options.maxRetries)return response;
   this.retryAttempts++;
   // We own 429 retries; the caller must set disableRetryOnRateLimit=true.
   await response.arrayBuffer().catch(()=>undefined);
  }
  throw new Error('Unreachable RPC retry state');
 };
}
