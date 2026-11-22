import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type AccountInfo,type Connection} from '@solana/web3.js';
import {MarketDataFeed} from '../src/marketData.js';
import {QuoteFailureGate,validateLocalComponents} from '../src/localWhirlpool.js';

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

test('C2 remembers one unquotable exact input only for its snapshot, then retries after a state change',()=>{
 const gate=new QuoteFailureGate(),pool='test-whirlpool';
 assert.equal(gate.blocked(pool,'USDC_TO_SOL',5000000n,'pool-slot-100:tick-a'),false);
 assert.equal(gate.reject(pool,'USDC_TO_SOL',5000000n,'pool-slot-100:tick-a',
  'insufficient_tick_array_traversal_for_input'),true);
 assert.equal(gate.reject(pool,'USDC_TO_SOL',5000000n,'pool-slot-100:tick-a',
  'same_error'),false,'duplicate should not inflate the unique error count');
 assert.equal(gate.blocked(pool,'USDC_TO_SOL',5000000n,'pool-slot-100:tick-a'),true);
 assert.equal(gate.blocked(pool,'USDC_TO_SOL',5000000n,'pool-slot-101:tick-b'),false,
  'a newer changed pool/tick snapshot must be retried');
 assert.equal(gate.reject(pool,'USDC_TO_SOL',5000000n,'pool-slot-101:tick-b',
  'insufficient_tick_array_traversal_for_input'),true);
 assert.equal(gate.summary().activeFailures,1);
 assert.equal(gate.summary().skippedRecalculations,1);
 assert.equal(gate.get(pool,'USDC_TO_SOL',5000000n)?.reason,
  'insufficient_tick_array_traversal_for_input');
 gate.recover(pool,'USDC_TO_SOL',5000000n);
 assert.equal(gate.summary().activeFailures,0);
});
test('C2 failure gate isolates input size and direction on the same pool',()=>{
 const gate=new QuoteFailureGate();
 gate.reject('pool-a','USDC_TO_SOL',5000000n,'state-a','tick_traversal_exceeded');
 assert.equal(gate.blocked('pool-a','USDC_TO_SOL',1000000n,'state-a'),false);
 assert.equal(gate.blocked('pool-a','SOL_TO_USDC',5000000n,'state-a'),false);
 assert.equal(gate.blocked('pool-b','USDC_TO_SOL',5000000n,'state-a'),false);
 gate.clearPool('pool-a');
 assert.equal(gate.summary().activeFailures,0);
});
