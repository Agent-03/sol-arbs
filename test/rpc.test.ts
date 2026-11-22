import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcHttpLimiter,parseRetryAfterMs} from '../src/rpc.js';
import {withRpcPriority} from '../src/rpcPriority.js';

const options={minSpacingMs:0,maxRetries:2,initialBackoffMs:1,maxBackoffMs:20};
const ok=()=>new Response('{"jsonrpc":"2.0","result":true}',{status:200});

test('interpret Retry-After seconds and HTTP-date',()=>{
 assert.equal(parseRetryAfterMs('3',0),3000);
 assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:04 GMT',0),4000);
 assert.equal(parseRetryAfterMs('garbage',0),null);
});
test('RPC fetch retries a 429 and counts attempts',async()=>{
 let calls=0;
 const transport=(async()=>{calls++;return calls===1?new Response('rate limited',{status:429,headers:{'retry-after':'0'}}):ok();}) as typeof fetch;
 const rpc=new RpcHttpLimiter(options,transport);
 const response=await rpc.fetch('https://rpc.invalid',{method:'POST',body:'{}'});
 assert.equal(response.status,200);
 assert.equal(rpc.snapshot().calls,1);
 assert.equal(rpc.snapshot().attempts,2);
 assert.equal(rpc.snapshot().rateLimits,1);
 assert.equal(rpc.snapshot().retryAttempts,1);
});
test('RPC limiter serializes competing SDK and scanner HTTP reads',async()=>{
 let inFlight=0,maxInFlight=0;
 const transport=(async()=>{
  inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
  await new Promise(r=>setTimeout(r,2));
  inFlight--;
  return ok();
 }) as typeof fetch;
 const rpc=new RpcHttpLimiter(options,transport);
 const results=await Promise.all(Array.from({length:5},()=>rpc.fetch('https://rpc.invalid')));
 assert.equal(maxInFlight,1);
 assert.equal(results.length,5);
 assert.equal(rpc.snapshot().attempts,5);
});
test('RPC 429 stops after configured maximum retry attempts',async()=>{
 let tries=0;
 const transport=(async()=>{tries++;return new Response('rate limited',{status:429});}) as typeof fetch;
 const rpc=new RpcHttpLimiter({...options,maxRetries:1},transport);
 const response=await rpc.fetch('https://rpc.invalid');
 assert.equal(response.status,429);
 assert.equal(tries,2);
 assert.equal(rpc.snapshot().retryAttempts,1);
 assert.equal(rpc.snapshot().rateLimits,2);
});
test('RPC transport failure propagates and increments error counter',async()=>{
 const transport=(async()=>{throw new Error('timeout');}) as typeof fetch;
 const rpc=new RpcHttpLimiter(options,transport);
 await assert.rejects(()=>rpc.fetch('https://rpc.invalid'),/timeout/);
 assert.equal(rpc.snapshot().transportErrors,1);
});

test('C3D.4.3 critical quote RPC leapfrogs queued normal and background calls',async()=>{
 const order:string[]=[];
 let release!:()=>void,started!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve});
 const entered=new Promise<void>(resolve=>{started=resolve});
 const transport=(async(_input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const id=String(init?.body);
  order.push(id);
  if(id==='block'){started();await blocked}
  return ok();
 }) as typeof fetch;
 const rpc=new RpcHttpLimiter({...options,maxConcurrent:1},transport);
 const first=rpc.fetch('https://rpc.invalid',{body:'block'});
 await entered;
 const bg=withRpcPriority('background',()=>rpc.fetch('https://rpc.invalid',{body:'background'}));
 const normal=rpc.fetch('https://rpc.invalid',{body:'normal'});
 const quote=withRpcPriority('quotes',()=>rpc.fetch('https://rpc.invalid',{body:'quote'}));
 assert.deepEqual(rpc.snapshot().pendingByPriority,
  {quotes:1,normal:1,background:1});
 release();
 await Promise.all([first,bg,normal,quote]);
 assert.deepEqual(order,['block','quote','normal','background']);
 assert.equal(rpc.snapshot().priorityDispatches.quotes,1);
 assert.equal(rpc.snapshot().priorityDispatches.background,1);
 assert.equal(rpc.snapshot().pending,0);
});

test('C3D.4.3 caps background HTTP concurrency while preserving quote slots',async()=>{
 let runningBg=0,peakBg=0;
 const order:string[]=[];
 let release!:()=>void,entered!:()=>void;
 const blocked=new Promise<void>(resolve=>{release=resolve});
 const firstStarted=new Promise<void>(resolve=>{entered=resolve});
 const transport=(async(_input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
  const id=String(init?.body);
  order.push(id);
  if(id.startsWith('bg')){
   runningBg++;peakBg=Math.max(peakBg,runningBg);
   entered();
   await blocked;
   runningBg--;
  }
  return ok();
 }) as typeof fetch;
 const rpc=new RpcHttpLimiter({...options,maxConcurrent:3,backgroundMaxConcurrent:1},transport);
 const background=Array.from({length:3},(_,i)=>
  withRpcPriority('background',()=>rpc.fetch('https://rpc.invalid',{body:'bg'+i})));
 await firstStarted;
 const live=withRpcPriority('quotes',()=>rpc.fetch('https://rpc.invalid',{body:'live'}));
 await live;
 assert.ok(order.includes('live'),'quote request starts despite queued background work');
 assert.equal(rpc.snapshot().inFlightByPriority.background,1);
 assert.equal(rpc.snapshot().pendingByPriority.background,2);
 release();
 await Promise.all(background);
 assert.equal(peakBg,1);
 assert.equal(rpc.snapshot().pending,0);
});

test('C3D.4.3 tracks queue wait and transport time separately by priority',async()=>{
 const trace:Array<{phase:string;queueWaitMs:number;transportMs?:number}>=[];
 const transport=(async()=>{
  await new Promise(resolve=>setTimeout(resolve,7));
  return ok();
 }) as typeof fetch;
 const rpc=new RpcHttpLimiter({...options,maxConcurrent:1},transport);
 const result=await withRpcPriority('quotes',()=>rpc.fetch('https://rpc.invalid'),
  event=>trace.push(event));
 assert.equal(result.status,200);
 assert.deepEqual(trace.map(x=>x.phase),['started','completed']);
 assert.ok(trace[1].transportMs!>=5);
 const snapshot=rpc.snapshot();
 assert.equal(snapshot.priorityDispatches.quotes,1);
 assert.ok(snapshot.transportMsP95.quotes>=5);
 assert.equal(snapshot.transportMsP95.background,0);
 assert.equal(snapshot.backgroundMaxConcurrent,1);
 assert.ok(snapshot.pacingMsP95.quotes>=0);
});
