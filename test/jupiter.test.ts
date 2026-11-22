import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRoundTrip,parseOrder} from '../src/jupiter.js';
test('parse Jupiter v2 quote-only order without wallet',()=>{
 const order=parseOrder({inAmount:'10000000',outAmount:'50000000',router:'metis',feeBps:2,transaction:null});
 assert.equal(order.inAmount,10000000n);
 assert.equal(order.outAmount,50000000n);
 assert.equal(order.router,'metis');
});
test('reject invalid or zero amounts',()=>{
 assert.throws(()=>parseOrder({inAmount:'0',outAmount:'123'}));
 assert.throws(()=>parseOrder({inAmount:'1000',outAmount:'abc'}));
});
test('round trip evaluates USDC raw units and assumed costs',()=>{
 const first={inAmount:10000000n,outAmount:50000000n,router:'metis',feeBps:2};
 const second={inAmount:50000000n,outAmount:10070000n,router:'metis',feeBps:2};
 const result=evaluateRoundTrip(10,first,second,0.02,'2026-11-21T00:00:00Z');
 assert.equal(result.estimatedGrossUsd,0.07);
 assert.equal(result.estimatedNetUsd,0.05);
 assert.equal(result.classification,'indicative_positive');
 assert.match(result.disclaimer,/NOT an atomic executable/);
});
test('reject route amount mismatch',()=>{
 const first={inAmount:10000000n,outAmount:50000000n,router:'metis',feeBps:2};
 const second={inAmount:49000000n,outAmount:10070000n,router:'metis',feeBps:2};
 assert.throws(()=>evaluateRoundTrip(10,first,second,0.02,'2026-11-21T00:00:00Z'));
});
