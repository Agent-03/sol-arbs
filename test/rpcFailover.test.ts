import test from 'node:test';
import assert from 'node:assert/strict';
import {RpcProviderPool} from '../src/rpcFailover.js';

const primary='https://primary.invalid/rpc?api-key=secret-test-primary';
const secondary='https://secondary.invalid/v2/secret-test-secondary';
const opts={minSpacingMs:0,maxRetries:1,initialBackoffMs:40,maxBackoffMs:40};
const ok=()=>new Response('{"jsonrpc":"2.0","result":{"value":[]}}',{status:200});

test('healthy primary serves requests without touching secondary',async()=>{
 const calls:string[]=[];
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  calls.push(String(input));
  return ok();
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 const response=await rpc.fetch(primary,{method:'POST',body:'{"method":"getVersion"}'});
 assert.equal(response.status,200);
 assert.deepEqual(calls,[primary]);
 assert.equal(rpc.snapshot().mode,'failover');
 assert.equal(rpc.snapshot().activeProvider,'primary');
 assert.equal(rpc.snapshot().failovers,0);
 assert.equal(JSON.stringify(rpc.snapshot()).includes('secret-test'),false);
});

test('429 on primary switches to secondary and honors independent cooldowns',async()=>{
 const calls:string[]=[];
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  const url=String(input);
  calls.push(url);
  return url===primary?new Response('rate limited',{status:429}):ok();
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 assert.equal((await rpc.fetch(primary,{method:'POST',body:'{}'})).status,200);
 assert.deepEqual(calls,[primary,secondary]);
 assert.equal(rpc.snapshot().primary.rateLimits,1);
 assert.equal(rpc.snapshot().secondarySuccesses,1);
 assert.equal(rpc.snapshot().activeProvider,'secondary');
 await rpc.fetch(primary,{method:'POST',body:'{}'});
 assert.deepEqual(calls,[primary,secondary,secondary]);
});

test('401 does not failover or expose a secret in diagnostics',async()=>{
 const calls:string[]=[];
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  calls.push(String(input));return new Response('invalid key',{status:401});
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 assert.equal((await rpc.fetch(primary)).status,401);
 assert.deepEqual(calls,[primary]);
 assert.equal(rpc.snapshot().failovers,0);
 assert.ok(!JSON.stringify(rpc.snapshot()).includes('secret-test'));
});

test('transport failure on primary can fail over to backup',async()=>{
 const calls:string[]=[];
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  const value=String(input);calls.push(value);
  if(value===primary)throw new Error('network failure');
  return ok();
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 assert.equal((await rpc.fetch(primary)).status,200);
 assert.deepEqual(calls,[primary,secondary]);
 assert.equal(rpc.snapshot().primaryFailures,1);
 assert.equal(rpc.snapshot().secondarySuccesses,1);
});

test('rate-limited secondary is not repeatedly hammered while both providers cool',async()=>{
 const calls:string[]=[];
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  calls.push(String(input));return new Response('rate limited',{status:429});
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 assert.equal((await rpc.fetch(primary)).status,429);
 assert.deepEqual(calls,[primary,secondary]);
 const second=await rpc.fetch(primary);
 assert.equal(second.status,503);
 assert.equal(calls.length,2);
 assert.equal(rpc.snapshot().primary.rateLimits,1);
 assert.equal(rpc.snapshot().secondary?.rateLimits,1);
});

test('request is rejected if it is not addressed to the primary endpoint',async()=>{
 const transport=(async()=>ok()) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 await assert.rejects(()=>rpc.fetch('https://unrelated.invalid/rpc'),/configured primary/);
});

test('one global queue serializes requests across both providers',async()=>{
 let concurrent=0,maxConcurrent=0;
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);
  await new Promise(r=>setTimeout(r,2));
  concurrent--;
  return String(input)===primary?new Response('try backup',{status:502}):ok();
 }) as typeof fetch;
 const rpc=new RpcProviderPool(primary,secondary,opts,transport);
 const all=await Promise.all(Array.from({length:4},()=>rpc.fetch(primary)));
 assert.ok(all.every(x=>x.status===200));
 assert.equal(maxConcurrent,1);
});

test('single-provider mode preserves existing 429 retries',async()=>{
 let calls=0;
 const transport=(async()=>{calls++;return calls===1?new Response('429',{status:429}):ok();}) as typeof fetch;
 const rpc=new RpcProviderPool(primary,undefined,{...opts,initialBackoffMs:1,maxBackoffMs:4},transport);
 assert.equal((await rpc.fetch(primary)).status,200);
 assert.equal(calls,2);
 assert.equal(rpc.snapshot().mode,'single');
});
