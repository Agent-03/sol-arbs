/**
 * Single-flight, shared Solana HTTP RPC limiter.
 *
 * All web3.js / Anchor / Whirlpool requests must use the same Connection
 * configured with this fetch function. This deliberately favors reliable,
 * read-only diagnostics over low-latency trading.
 */
export type RpcLimitOptions={
 minSpacingMs:number;
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
 private chain:Promise<void>=Promise.resolve();
 private waiting=0;
 private lastAttemptAt=0;
 private cooldownUntil=0;
 private calls=0;
 private attempts=0;
 private rateLimits=0;
 private retryAttempts=0;
 private transportErrors=0;
 private last429At?:string;

 constructor(private readonly options:RpcLimitOptions,private readonly transport:typeof fetch=globalThis.fetch){
  if(!Number.isSafeInteger(options.minSpacingMs)||options.minSpacingMs<0||
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
   minSpacingMs:this.options.minSpacingMs,queued:this.waiting>0};
 }
 private async exclusive<T>(action:()=>Promise<T>):Promise<T>{
  this.waiting++;
  const previous=this.chain;
  let release!:()=>void;
  this.chain=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try{
   const until=Math.max(this.cooldownUntil,this.lastAttemptAt+this.options.minSpacingMs);
   if(until>Date.now())await sleep(until-Date.now());
   this.lastAttemptAt=Date.now();
   return await action();
  }finally{this.waiting--;release();}
 }
 readonly fetch:typeof globalThis.fetch=async (input,init)=>{
  this.calls++;
  for(let attempt=0;attempt<=this.options.maxRetries;attempt++){
   const response=await this.exclusive(async()=>{
    this.attempts++;
    try{return await this.transport(input,init);}
    catch(error){this.transportErrors++;throw error;}
   });
   if(response.status!==429)return response;
   this.rateLimits++;
   this.last429At=new Date().toISOString();
   const retryAfter=parseRetryAfterMs(response.headers.get('retry-after'));
   const delay=Math.min(this.options.maxBackoffMs,Math.max(this.options.initialBackoffMs*(2**attempt),retryAfter??0));
   this.cooldownUntil=Math.max(this.cooldownUntil,Date.now()+delay);
   if(attempt===this.options.maxRetries)return response;
   this.retryAttempts++;
   // We own 429 retries; the caller must set disableRetryOnRateLimit=true.
   await response.arrayBuffer().catch(()=>undefined);
  }
  throw new Error('Unreachable RPC retry state');
 };
}
