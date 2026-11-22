import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcHttpLimiter,parseRetryAfterMs} from '../src/rpc.js';

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
