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
};

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function parseRetryAfterMs(value:string|null,now=Date.now()):number|null {
 if(!value)return null;
 const seconds=Number(value.trim());
 if(Number.isFinite(seconds)&&seconds>=0)return Math.round(seconds*1000);
 const date=Date.parse(value);
 return Number.isFinite(date)?Math.max(0,date-now):null;
}

export class RpcHttpLimiter {
 private pacing:Promise<void>=Promise.resolve();
 private readonly capacity:number;
 private waiters:Array<()=>void>=[];
 private waiting=0;
 private running=0;
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
  if(!Number.isSafeInteger(this.capacity)||this.capacity<1||this.capacity>16||
     !Number.isSafeInteger(options.minSpacingMs)||options.minSpacingMs<0||
     !Number.isSafeInteger(options.maxRetries)||options.maxRetries<0||options.maxRetries>5||
     !Number.isSafeInteger(options.initialBackoffMs)||options.initialBackoffMs<1||
     !Number.isSafeInteger(options.maxBackoffMs)||options.maxBackoffMs<options.initialBackoffMs){
   throw new Error('Invalid RPC limiter configuration');
  }
 }
 snapshot():RpcLimitSnapshot{
  return {calls:this.calls,attempts:this.attempts,rateLimits:this.rateLimits,
   retryAttempts:this.retryAttempts,transportErrors:this.transportErrors,
   last429At:this.last429At,
   cooldownUntil:this.cooldownUntil>Date.now()?new Date(this.cooldownUntil).toISOString():undefined,
   minSpacingMs:this.options.minSpacingMs,maxConcurrent:this.capacity,
   inFlight:this.running,pending:Math.max(0,this.waiting-this.running),
   queued:this.waiting>this.running};
 }
 private async exclusive<T>(action:()=>Promise<T>):Promise<T>{
  this.waiting++;
  if(this.running>=this.capacity){
   await new Promise<void>(resolve=>this.waiters.push(resolve));
  }
  this.running++;
  // Only pace the initiation of requests. Do not hold a provider-wide lock
  // while the HTTP response is pending: independent reads overlap safely.
  const previous=this.pacing;
  let release!:()=>void;
  this.pacing=new Promise<void>(resolve=>{release=resolve});
  await previous;
  try{
   const until=Math.max(this.cooldownUntil,this.lastAttemptAt+this.options.minSpacingMs);
   if(until>Date.now())await sleep(until-Date.now());
   this.lastAttemptAt=Date.now();
  }finally{release()}
  try{return await action()}
  finally{
   this.running--;this.waiting--;
   this.waiters.shift()?.();
  }
 }
 readonly fetch:typeof globalThis.fetch=async (input,init)=>{
  this.calls++;
  for(let attempt=0;attempt<=this.options.maxRetries;attempt++){
   // Capture 429 and establish the shared cooldown *before* allowing
   // the next queued RPC call to start.
   const response=await this.exclusive(async()=>{
    this.attempts++;
    let received:Response;
    try{received=await this.transport(input,init);}
    catch(error){this.transportErrors++;throw error;}
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
