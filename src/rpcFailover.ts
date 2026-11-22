import {RpcHttpLimiter,type RpcLimitOptions,type RpcLimitSnapshot} from './rpc.js';

/**
 * An optional standby endpoint for Solana HTTP JSON-RPC requests.
 * WebSocket subscriptions remain on the primary Connection's WS endpoint.
 * No signing, transaction submission, or user secrets are stored here.
 */
export type RpcFailoverSnapshot = {
 mode:'single'|'failover';
 activeProvider:'primary'|'secondary';
 failovers:number;
 secondarySuccesses:number;
 primaryFailures:number;
 secondaryFailures:number;
 lastFailoverAt?:string;
 primary:RpcLimitSnapshot;
 secondary?:RpcLimitSnapshot;
};

function requestUrl(input:Parameters<typeof fetch>[0]):string {
 return typeof input==='string'?input:input instanceof URL?input.toString():input.url;
}
function isFailoverStatus(status:number):boolean {
 return status===429||status===500||status===502||status===503||status===504;
}

/**
 * Keeps the upstream RPC client on a single Connection and redirects only
 * its HTTP transport requests. Calls are serialized (across both providers)
 * and a 429 cooldown on one provider does not freeze the other provider.
 *
 * HTTP 401/403, application JSON-RPC errors and successful HTTP 200
 * responses are NOT automatically failed over.
 */
export class RpcProviderPool {
 private readonly primary:RpcHttpLimiter;
 private readonly secondary?:RpcHttpLimiter;
 private serial:Promise<void>=Promise.resolve();
 private primaryFailedUntil=0;
 private secondaryFailedUntil=0;
 private failovers=0;
 private secondarySuccesses=0;
 private primaryFailures=0;
 private secondaryFailures=0;
 private activeProvider:'primary'|'secondary'='primary';
 private lastFailoverAt?:string;

 constructor(
  private readonly primaryUrl:string,
  private readonly secondaryUrl:string|undefined,
  options:RpcLimitOptions,
  transport:typeof fetch=globalThis.fetch
 ){
  const validate=(value:string)=>{const url=new URL(value);if(url.protocol!=='https:')throw new Error('Solana RPC URLs must be HTTPS');return url.toString();};
  const primary=validate(primaryUrl);
  if(secondaryUrl && validate(secondaryUrl)===primary)throw new Error('Secondary Solana RPC must differ from the primary');
  this.primary=new RpcHttpLimiter(secondaryUrl?{...options,maxRetries:0}:options,transport);
  this.secondary=secondaryUrl?new RpcHttpLimiter({...options,maxRetries:0},transport):undefined;
 }
 private readonly failedForMs=10_000;

 private cooling(limiter:RpcHttpLimiter,unhealthyUntil:number):boolean {
  const from429=limiter.snapshot().cooldownUntil;
  return Math.max(unhealthyUntil,from429?Date.parse(from429):0)>Date.now();
 }
 private inputForSecondary(input:Parameters<typeof fetch>[0]):Parameters<typeof fetch>[0]{
  if(!this.secondaryUrl)throw new Error('Secondary RPC unavailable');
  // Solana web3.js supplies a URL string and init.body. Preserve method and
  // request bytes while replacing ONLY the destination URL.
  return typeof input==='string'||input instanceof URL
   ?this.secondaryUrl
   :new Request(this.secondaryUrl,input.clone());
 }

 private async doFetch(input:Parameters<typeof fetch>[0],init?:RequestInit):Promise<Response>{
  if(!this.secondary){
   return this.primary.fetch(input,init);
  }
  // Never forward non-RPC fetches or API-key-bearing URLs to a backup.
  if(new URL(requestUrl(input)).toString()!==new URL(this.primaryUrl).toString()){
   throw new Error('RPC request target differs from configured primary endpoint');
  }
  let primaryResponse:Response|undefined;
  let primaryError:unknown;
  if(!this.cooling(this.primary,this.primaryFailedUntil)){
   try{
    primaryResponse=await this.primary.fetch(input,init);
    if(!isFailoverStatus(primaryResponse.status)){
     this.activeProvider='primary';
     return primaryResponse;
    }
    this.primaryFailures++;
    if(primaryResponse.status!==429)this.primaryFailedUntil=Date.now()+this.failedForMs;
   }catch(error){
    this.primaryFailures++;
    this.primaryFailedUntil=Date.now()+this.failedForMs;
    primaryError=error;
   }
  }
  if(!this.cooling(this.secondary,this.secondaryFailedUntil)){
   this.failovers++;
   this.lastFailoverAt=new Date().toISOString();
   try{
    const response=await this.secondary.fetch(this.inputForSecondary(input),init);
    if(!isFailoverStatus(response.status)){
     this.secondarySuccesses++;
     this.activeProvider='secondary';
     return response;
    }
    this.secondaryFailures++;
    if(response.status!==429)this.secondaryFailedUntil=Date.now()+this.failedForMs;
    // Expose the secondary provider's own response if it could not serve
    // this request; do not silently pretend the quote is fresh.
    return response;
   }catch(error){
    this.secondaryFailures++;
    this.secondaryFailedUntil=Date.now()+this.failedForMs;
    if(primaryResponse)return primaryResponse;
    throw new Error('Both Solana RPC providers failed to serve this request',{cause:error});
   }
  }
  if(primaryResponse)return primaryResponse;
  if(primaryError)throw new Error('Primary RPC failed; backup RPC is cooling down',{cause:primaryError});
  return new Response(JSON.stringify({error:'Both RPC providers are cooling down'}),{
   status:503,headers:{'content-type':'application/json'}
  });
 }
 readonly fetch:typeof globalThis.fetch=async (input,init)=>{
  // One global transport queue shared by the account scanner, Raydium, and
  // Orca SDK, even when two different RPC backends are configured.
  let release!:()=>void;
  const previous=this.serial;
  this.serial=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  try{return await this.doFetch(input,init);}
  finally{release();}
 };
 snapshot():RpcFailoverSnapshot {
  return {
   mode:this.secondary?'failover':'single',activeProvider:this.activeProvider,
   failovers:this.failovers,secondarySuccesses:this.secondarySuccesses,
   primaryFailures:this.primaryFailures,secondaryFailures:this.secondaryFailures,
   lastFailoverAt:this.lastFailoverAt,primary:this.primary.snapshot(),
   secondary:this.secondary?.snapshot()
  };
 }
}
