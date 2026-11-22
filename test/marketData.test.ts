import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type AccountInfo,type Connection} from '@solana/web3.js';
import {MarketDataFeed} from '../src/marketData.js';

const addresses=Array.from({length:4},(_,i)=>new PublicKey(Buffer.alloc(32,i+1)).toBase58());
const owners=[new PublicKey(Buffer.alloc(32,25)).toBase58(),
 new PublicKey(Buffer.alloc(32,26)).toBase58()];
const info=(value:number,owner=owners[0]):AccountInfo<Buffer>=>({
 data:Buffer.from([value]),owner:new PublicKey(owner),lamports:100+value,
 executable:false,rentEpoch:99
});
function fixture(){
 let ids=0;
 const callbacks=new Map<string,(info:AccountInfo<Buffer>,ctx:{slot:number})=>void>();
 const removed:number[]=[];
 let reads=0;
 const connection={
  onAccountChange:(key:PublicKey,cb:(info:AccountInfo<Buffer>,ctx:{slot:number})=>void)=>{
   callbacks.set(key.toBase58(),cb);return ++ids;
  },
  removeAccountChangeListener:async(id:number)=>{removed.push(id);},
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
   reads++;return {context:{slot:100},
    value:keys.map((_,i)=>info(10+i))};
  }
 } as unknown as Connection;
 return {connection,callbacks,removed,get watchers(){return ids;},get reads(){return reads;}};
}
test('deduplicates live subscriptions, routes events only to affected pools and releases once',async()=>{
 const f=fixture(),feed=new MarketDataFeed(f.connection,5000,4);
 const [a,b]=addresses;
 feed.setDependencies('pool-A',[a,b]);
 feed.setDependencies('pool-B',[b]);
 const events:Array<{address:string;pools:string[]}>=[];
 feed.onUpdate(e=>events.push({address:e.address,pools:e.affectedPools}));
 const releaseA=feed.watch(a),releaseB1=feed.watch(b),releaseB2=feed.watch(b);
 assert.equal(f.watchers,2);
 f.callbacks.get(a)?.(info(1),{slot:12});
 f.callbacks.get(b)?.(info(2),{slot:13});
 assert.deepEqual(events.map(e=>e.pools),[['pool-A'],['pool-A','pool-B']]);
 assert.equal(feed.snapshot(Date.now()).watchedAccounts,2);
 releaseB1();releaseB1();
 assert.equal(feed.snapshot().watchedAccounts,2,'duplicate disposal removed a live subscription');
 releaseB2();releaseA();
 assert.equal(feed.snapshot().watchedAccounts,0);
 await feed.stop();
 assert.deepEqual(f.removed.sort((x,y)=>x-y),[1,2]);
});
test('slot monotonicity, duplicate data and stale RPC reads never overwrite WebSocket state',async()=>{
 const f=fixture(),feed=new MarketDataFeed(f.connection,1000,2);
 const at=Date.parse('2026-11-22T10:00:00.000Z');
 const addr=addresses[0];
 assert.equal(feed.ingest(addr,info(1),70,'websocket',at),true);
 assert.equal(feed.ingest(addr,info(9),69,'rpc_poll',at+1500),false);
 assert.equal(feed.ingest(addr,info(1),70,'rpc_reconcile',at+1600),false);
 assert.equal(feed.ingest(addr,info(5),70,'rpc_poll',at+1700),false);
 assert.equal(feed.get(addr)?.receivedAt,at,'repeated reads must not reset the market observation time');
 assert.equal(feed.get(addr)?.verifiedAt,at+1600);
 assert.equal(feed.get(addr)?.data[0],1);
 assert.equal(feed.ingest(addr,info(6),71,'websocket',at+1701),true);
 assert.equal(feed.get(addr)?.lamports,106);
 const health=feed.snapshot(at+1800);
 assert.equal(health.olderSlotDrops,2);
 assert.equal(health.duplicateUpdates,1);
 assert.equal(health.wsUpdates,2);
 assert.equal(f.reads,0,'websocket update path must not perform RPC');
 await feed.stop();
});
test('owner checks reject corrupt events; dependency health fails closed on stale or mismatched slots',async()=>{
 const f=fixture(),feed=new MarketDataFeed(f.connection,1000,2);
 const [a,b]=addresses;
 const at=Date.parse('2026-11-22T10:00:00.000Z');
 feed.expectOwner(a,owners[0]);
 feed.setDependencies('raydium',[a,b]);
 assert.equal(feed.ingest(a,info(10,owners[1]),20,'websocket',at),false);
 assert.equal(feed.snapshot(at).ownerMismatchDrops,1);
 assert.equal(feed.snapshot(at).pools[0].state,'missing');
 feed.ingest(a,info(10),20,'websocket',at);
 feed.ingest(b,info(11),30,'websocket',at);
 assert.equal(feed.snapshot(at+200).pools[0].state,'slot_skew');
 feed.ingest(b,info(12),21,'websocket',at+200);
 assert.equal(feed.snapshot(at+400).readyPools,1);
 assert.equal(feed.snapshot(at+1100).pools[0].state,'stale');
 feed.clearDependencies('raydium');
 assert.equal(feed.snapshot(at+1100).poolDependencies,0);
 await feed.stop();
});
test('RPC bootstrap reads a single context per group and dispatches account dependencies',async()=>{
 const f=fixture(),feed=new MarketDataFeed(f.connection);
 const [a,b,c]=addresses;
 feed.setDependencies('pool-one',[a,b,c]);
 const affected:string[]=[];
 feed.onUpdate(update=>affected.push(...update.affectedPools));
 await feed.reconcile([a,b,c],'rpc_bootstrap');
 assert.equal(f.reads,1);
 assert.equal(feed.snapshot().trackedAccounts,3);
 assert.equal(feed.get(b)?.slot,100);
 assert.deepEqual(affected,['pool-one','pool-one','pool-one']);
 await feed.stop();
});
