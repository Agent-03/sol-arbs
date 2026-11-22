import test from 'node:test';
import assert from 'node:assert/strict';
import {assessRoutes} from '../src/opportunities.js';
import {evaluateRoute} from '../src/orca.js';

const now=Date.parse('2026-11-22T03:40:00.000Z');
const rules={maxAgeMs:10000,maxGapMs:3000,maxSlotSkew:12};
const route=(buyTime:number,sellTime:number,buySlot:number|null,sellSlot:number|null,profit=0.1)=>
 evaluateRoute(10,
  {pool:'ray',venue:'raydium',inputRaw:'10000000',outputRaw:'140000000',observedAt:new Date(buyTime).toISOString(),slot:buySlot},
  {pool:'orca',venue:'orca',inputRaw:'140000000',outputRaw:String(Math.round((10+profit+0.02)*1e6)),observedAt:new Date(sellTime).toISOString(),slot:sellSlot},0.02);

test('qualifies an aligned quote only for comparison, never for execution',()=>{
 const x=assessRoutes([route(now-1500,now-900,30,31)],rules,now);
 assert.equal(x.comparable,1);
 assert.equal(x.positiveComparable,1);
 assert.equal(x.bestComparableNetUsd,0.09999999999999999);
 assert.equal(x.bestComparable?.classification,'indicative_only');
 assert.equal(x.bestComparable?.eligibleForComparison,true);
 assert.ok(x.bestComparable?.rejectionReasons.includes('not_atomic_transaction_simulation'));
});
test('stale route with higher paper P&L cannot outrank a fresh lower P&L',()=>{
 const stale=route(now-50000,now-30000,99,100,50);
 const fresh=route(now-1000,now-950,99,100,-0.005);
 const x=assessRoutes([stale,fresh],rules,now);
 assert.equal(x.comparable,1);
 assert.equal(x.positiveComparable,0);
 assert.equal(x.bestComparable?.indicativeNetUsd,-0.005000000000000001);
 assert.equal(x.excludedCandidates[0].freshness,'stale');
 assert.ok(x.excludedCandidates[0].freshnessReasons.includes('quote_age_exceeded'));
 assert.ok(x.excludedCandidates[0].freshnessReasons.includes('quote_gap_exceeded'));
});
test('rejects unknown slots and excessive slot skew for comparison',()=>{
 const unknown=route(now-1000,now-900,null,100);
 const skew=route(now-1000,now-900,80,105);
 const x=assessRoutes([unknown,skew],rules,now);
 assert.equal(x.comparable,0);
 assert.equal(x.bestComparableNetUsd,null);
 assert.equal(x.excludedByReason.missing_pool_slot,1);
 assert.equal(x.excludedByReason.pool_slot_skew_exceeded,1);
});
test('becomes stale as time passes even without a new scan',()=>{
 const q=route(now-2000,now-1000,123,123);
 assert.equal(assessRoutes([q],rules,now).comparable,1);
 assert.equal(assessRoutes([q],rules,now+15000).comparable,0);
});
test('handles no routes without fabricating profitability',()=>{
 const x=assessRoutes([],rules,now);
 assert.equal(x.total,0);
 assert.equal(x.bestComparableNetUsd,null);
 assert.equal(x.bestRawNetUsd,null);
});

test('low-liquidity candidates are excluded even when quotes are timely',()=>{
 const q=route(now-1000,now-500,3,4,0.2);
 const withLiquidity={...q,buyLiquidityUsd:200000,sellLiquidityUsd:1200};
 const x=assessRoutes([withLiquidity],{...rules,minLiquidityUsd:10000},now);
 assert.equal(x.comparable,0);
 assert.equal(x.excludedByReason.insufficient_pool_liquidity,1);
});
test('unknown liquidity cannot be upgraded to a research-aligned route',()=>{
 const x=assessRoutes([route(now-1000,now-500,3,4,0.2)],{...rules,minLiquidityUsd:10000},now);
 assert.equal(x.comparable,0);
 assert.equal(x.excludedByReason.unknown_pool_liquidity,1);
});
