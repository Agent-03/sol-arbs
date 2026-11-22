import {RpcHttpLimiter,type RpcLimitOptions,type RpcLimitSnapshot} from './rpc.js';

/** Two independent HTTP Solana RPC lanes. WS notifications stay on primary;
 * account monotonicity and bounded slot checks protect mixed RPC snapshots.
 */
export type RpcFailoverSnapshot={
 mode:'single'|'failover'|'dual_active';
 activeProvider:'primary'|'secondary';
 failovers:number;secondarySuccesses:number;
 primaryFailures:number;secondaryFailures:number;
 primaryAssigned:number;secondaryAssigned:number;
 inFlight:number;peakInFlight:number;
 lastFailoverAt?:string;
 primary:RpcLimitSnapshot;secondary?:RpcLimitSnapshot;
};
type Provider='primary'|'secondary';
const requestUrl=(input:Parameters<typeof fetch>[0]):string=>
 typeof input==='string'?input:input instanceof URL?input.toString():input.url;
const failedStatus=(n:number)=>n===429||n===500||n===502||n===503||n===504;

/** `dualActive` distributes HTTP reads over both RPC providers instead
 * of serializing them through a global request lock. Each provider has its
 * own concurrency cap, pacing and 429 cooldown. Failover is independent
 * of the active-active scheduler. No credentials are forwarded to another host.
 */
export class RpcProviderPool{
 private readonly primary:RpcHttpLimiter;
 private readonly secondary?:RpcHttpLimiter;
 private readonly dualActive:boolean;
 private primaryFailedUntil=0;private secondaryFailedUntil=0;
 private failovers=0;private secondarySuccesses=0;
 private primaryFailures=0;private secondaryFailures=0;
 private primaryAssigned=0;private secondaryAssigned=0;
 private inFlight=0;private peakInFlight=0;
 private roundRobin=0;
 private activeProvider:Provider='primary';
 private lastFailoverAt?:string;
 private readonly failedForMs=10000;
 constructor(
  private readonly primaryUrl:string,
  private readonly secondaryUrl:string|undefined,
  options:RpcLimitOptions,
  transport:typeof fetch=globalThis.fetch,
  settings:{dualActive?:boolean;secondaryOptions?:RpcLimitOptions}={}
 ){
  const check=(url:string)=>{const u=new URL(url);
   if(u.protocol!=='https:')throw new Error('Solana RPC URLs must be HTTPS');
   return u.toString();
  };
  if(secondaryUrl&&check(secondaryUrl)===check(primaryUrl))
   throw new Error('Secondary Solana RPC must differ from primary');
  check(primaryUrl);
  this.primary=new RpcHttpLimiter(secondaryUrl?{...options,maxRetries:0}:options,transport);
  this.secondary=secondaryUrl?new RpcHttpLimiter({
   ...(settings.secondaryOptions??options),maxRetries:0
  },transport):undefined;
  this.dualActive=!!this.secondary&&!!settings.dualActive;
 }
 private cooling(provider:Provider):boolean{
  const limiter=provider==='primary'?this.primary:this.secondary;
  if(!limiter)return true;
  const cooldown=limiter.snapshot().cooldownUntil;
  const unhealthy=provider==='primary'?this.primaryFailedUntil:this.secondaryFailedUntil;
  return Math.max(unhealthy,cooldown?Date.parse(cooldown):0)>Date.now();
 }
 private secondaryRequest(input:Parameters<typeof fetch>[0],init?:RequestInit){
  if(!this.secondaryUrl)throw new Error('Secondary RPC unavailable');
  const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
  for(const name of ['authorization','proxy-authorization','x-api-key','cookie'])headers.delete(name);
  const target:Parameters<typeof fetch>[0]=
   input instanceof Request?new Request(this.secondaryUrl,input.clone()):this.secondaryUrl;
  return {input:target,init:{...init,headers} as RequestInit};
 }
 private async attempt(provider:Provider,input:Parameters<typeof fetch>[0],init?:RequestInit){
  const limiter=provider==='primary'?this.primary:this.secondary!;
  if(provider==='primary')this.primaryAssigned++;else this.secondaryAssigned++;
  const resolved=provider==='secondary'?this.secondaryRequest(input,init):{input,init};
  try{
   const response=await limiter.fetch(resolved.input,resolved.init);
   if(failedStatus(response.status)){
    if(provider==='primary')this.primaryFailures++;else this.secondaryFailures++;
    if(response.status!==429){
     if(provider==='primary')this.primaryFailedUntil=Date.now()+this.failedForMs;
     else this.secondaryFailedUntil=Date.now()+this.failedForMs;
    }
   }else{
    this.activeProvider=provider;
    if(provider==='secondary')this.secondarySuccesses++;
   }
   return response;
  }catch(error){
   if(provider==='primary'){
    this.primaryFailures++;this.primaryFailedUntil=Date.now()+this.failedForMs;
   }else{
    this.secondaryFailures++;this.secondaryFailedUntil=Date.now()+this.failedForMs;
   }
   throw error;
  }
 }
 private async doFetch(input:Parameters<typeof fetch>[0],init?:RequestInit){
  if(!this.secondary)return this.primary.fetch(input,init);
  if(new URL(requestUrl(input)).toString()!==new URL(this.primaryUrl).toString())
   throw new Error('RPC request target differs from configured primary endpoint');
  const chosen:Provider=this.dualActive&&this.roundRobin++%2===1?'secondary':'primary';
  const fallback:Provider=chosen==='primary'?'secondary':'primary';
  let firstResponse:Response|undefined,firstError:unknown;
  if(!this.cooling(chosen)){
   try{
    firstResponse=await this.attempt(chosen,input,init);
    if(!failedStatus(firstResponse.status))return firstResponse;
   }catch(error){firstError=error}
  }
  if(!this.cooling(fallback)){
   this.failovers++;this.lastFailoverAt=new Date().toISOString();
   try{
    const response=await this.attempt(fallback,input,init);
    if(!failedStatus(response.status))return response;
    return response;
   }catch(error){
    if(firstResponse)return firstResponse;
    if(firstError)throw new Error('Both Solana RPC providers failed to serve this request');
    throw error;
   }
  }
  if(firstResponse)return firstResponse;
  if(firstError)throw new Error('Preferred RPC failed; alternate RPC cooling down');
  return new Response(JSON.stringify({error:'Both RPC providers are cooling down'}),{
   status:503,headers:{'content-type':'application/json'}
  });
 }
 readonly fetch:typeof globalThis.fetch=async(input,init)=>{
  this.inFlight++;
  this.peakInFlight=Math.max(this.peakInFlight,this.inFlight);
  try{return await this.doFetch(input,init)}
  finally{this.inFlight--}
 };
 snapshot():RpcFailoverSnapshot{
  return {
   mode:this.dualActive?'dual_active':this.secondary?'failover':'single',
   activeProvider:this.activeProvider,failovers:this.failovers,
   secondarySuccesses:this.secondarySuccesses,primaryFailures:this.primaryFailures,
   secondaryFailures:this.secondaryFailures,primaryAssigned:this.primaryAssigned,
   secondaryAssigned:this.secondaryAssigned,inFlight:this.inFlight,
   peakInFlight:this.peakInFlight,lastFailoverAt:this.lastFailoverAt,
   primary:this.primary.snapshot(),secondary:this.secondary?.snapshot()
  };
 }
}
