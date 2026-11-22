import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateRoute} from '../src/orca.js';
const t='2026-11-22T03:04:12.000Z';
test('two-leg cross-venue raw amounts show indicative margin only',()=>{
 const result=evaluateRoute(10,{pool:'ray',venue:'raydium',inputRaw:'10000000',outputRaw:'143000000',observedAt:t},
 {pool:'orca',venue:'orca',inputRaw:'143000000',outputRaw:'10050000',observedAt:t},0.02);
 assert.equal(result.grossUsd,0.05);
 assert.equal(result.indicativeNetUsd,0.030000000000000002);
 assert.equal(result.classification,'indicative_only');
 assert.ok(result.rejectionReasons.includes('not_atomic_transaction_simulation'));
});
test('reject a non-contiguous route',()=>{
 assert.throws(()=>evaluateRoute(10,{pool:'ray',venue:'raydium',inputRaw:'10000000',outputRaw:'143000000',observedAt:t},
 {pool:'orca',venue:'orca',inputRaw:'142000000',outputRaw:'10050000',observedAt:t},0.02));
});
test('permit separate pools on same venue, reject reusing the same pool',()=>{
 const candidate=evaluateRoute(5,{pool:'A',venue:'raydium',inputRaw:'5000000',outputRaw:'100',observedAt:t},
 {pool:'B',venue:'raydium',inputRaw:'100',outputRaw:'5000001',observedAt:t},0);
 assert.equal(candidate.buyVenue,'raydium');
 assert.equal(candidate.sellVenue,'raydium');
 assert.equal(candidate.indicativeNetUsd,0.000001);
 assert.throws(()=>evaluateRoute(5,{pool:'A',venue:'raydium',inputRaw:'5000000',outputRaw:'100',observedAt:t},
 {pool:'A',venue:'raydium',inputRaw:'100',outputRaw:'5000001',observedAt:t},0));
});
test('flag stale quote time gap',()=>{
 const result=evaluateRoute(5,{pool:'A',venue:'raydium',inputRaw:'5000000',outputRaw:'100',observedAt:t},
 {pool:'B',venue:'orca',inputRaw:'100',outputRaw:'5000001',observedAt:'2026-11-22T03:04:15.001Z'},0);
 assert.ok(result.rejectionReasons.includes('quote_time_gap_over_2s'));
});
