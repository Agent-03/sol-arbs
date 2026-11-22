import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type AccountInfo,type Connection} from '@solana/web3.js';
import {MarketDataFeed} from '../src/marketData.js';
import {validateLocalComponents} from '../src/localWhirlpool.js';

const start=Date.parse('2026-11-22T07:30:00Z');
test('C2 rejects stale, future and slot-inconsistent pool/tick snapshots',()=>{
 const a={slot:100,receivedAt:start};
 const b={slot:101,receivedAt:start+300};
 assert.deepEqual(validateLocalComponents([a,b],start+1000,15000,12),
  {ok:true,oldestAt:start,minSlot:100});
 assert.equal(validateLocalComponents([a,b],start+16000,15000,12).reason,'component_age');
 assert.equal(validateLocalComponents([a,{slot:120,receivedAt:start}],start,15000,12).reason,'slot_skew');
 assert.equal(validateLocalComponents([{slot:99,receivedAt:start+2000}],start,15000,12).reason,'future_observation');
 assert.equal(validateLocalComponents([],start,15000,12).reason,'missing_component');
});
test('C2 accepts empty tick arrays only after a verified RPC null at a known slot',async()=>{
 const key=new PublicKey(Buffer.alloc(32,55)).toBase58();
 const owner=new PublicKey(Buffer.alloc(32,77));
 const rows=new Map<string,AccountInfo<Buffer>|null>([[key,null]]);
 let slot=100;
 const connection={
  getMultipleAccountsInfoAndContext:async (keys:PublicKey[])=>({
   context:{slot},
   value:keys.map(k=>rows.get(k.toBase58())??null)
  }),
  onAccountChange:()=>1,
  removeAccountChangeListener:async()=>{}
 } as unknown as Connection;
 const feed=new MarketDataFeed(connection,30000,12);
 assert.equal(feed.getVerifiedAbsent(key),undefined,'unknown missing account is not verified');
 await feed.reconcile([key],'rpc_bootstrap');
 const absent=feed.getVerifiedAbsent(key);
 assert.equal(absent?.slot,100);
 assert.equal(feed.snapshot().verifiedAbsentAccounts,1);
 const account:AccountInfo<Buffer>={data:Buffer.from([4]),owner,
  executable:false,lamports:20,rentEpoch:0};
 assert.equal(feed.ingest(key,account,99,'websocket'),false,
  'older data cannot rewind a verified account absence');
 assert.equal(feed.getVerifiedAbsent(key)?.slot,100);
 assert.equal(feed.ingest(key,account,101,'websocket'),true);
 assert.equal(feed.getVerifiedAbsent(key),undefined);
 assert.equal(feed.get(key)?.data[0],4);
 assert.equal(feed.snapshot().verifiedAbsentAccounts,0);
 await feed.stop();
});
