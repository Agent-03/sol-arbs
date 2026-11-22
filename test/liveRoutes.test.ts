import test from 'node:test';
import assert from 'node:assert/strict';
import {combineLiveQuotes} from '../src/liveRoutes.js';
import type {AmmV4Quote} from '../src/ammV4.js';
import type {OrcaQuote} from '../src/orca.js';
import {assessRoutes} from '../src/opportunities.js';

const ts='2026-11-22T04:00:00.000Z';
const ray:AmmV4Quote={
 pool:'Ray-1',direction:'USDC_TO_SOL',inputRaw:'5000000',outputRaw:'71000000',
 slot:103,vaultSlot:102,observedAt:ts,
 feeNumerator:'25',feeDenominator:'10000',
 reserveInRaw:'70000000',reserveOutRaw:'1000000000',
 classification:'indicative_non_executable'
};
const orcaBuy:OrcaQuote={
 pool:'Orca-1',direction:'USDC_TO_SOL',inputRaw:'5000000',outputRaw:'72000000',
 feeRaw:'2000',observedAt:ts,poolSlot:103,classification:'indicative_non_executable'
};
const orcaSell:OrcaQuote={
 pool:'Orca-1',direction:'SOL_TO_USDC',inputRaw:'71000000',outputRaw:'5050000',
 feeRaw:'2500',observedAt:ts,poolSlot:103,classification:'indicative_non_executable'
};
const liquidity=new Map<string,number|undefined>([['Ray-1',250000],['Orca-1',400000]]);
test('local route combiner produces both directions when exact inputs match',()=>{
 const x=combineLiveQuotes([ray],[orcaBuy,orcaSell],0.02,liquidity);
 assert.equal(x.candidates.length,2);
 assert.equal(x.failed,0);
 const buyOrca=x.candidates.find(c=>c.buyVenue==='orca');
 const buyRay=x.candidates.find(c=>c.buyVenue==='raydium');
 assert.ok(buyOrca);assert.ok(buyRay);
 assert.equal(buyOrca.sellPool,'Ray-1');
 assert.equal(buyOrca.buySlot,103);
 assert.equal(buyOrca.sellSlot,102);
 assert.equal(buyOrca.buyLiquidityUsd,400000);
 assert.equal(buyRay.inputUsdcRaw,'5000000');
 assert.equal(buyRay.outputUsdcRaw,'5050000');
 assert.equal(buyRay.indicativeNetUsd,0.030000000000000002);
 assert.ok(buyRay.rejectionReasons.includes('not_atomic_transaction_simulation'));
});
test('rejects stale Orca reverse quotes when Raydium exact input has moved',()=>{
 const shifted={...ray,outputRaw:'71000001'};
 const x=combineLiveQuotes([shifted],[orcaBuy,orcaSell],0.02,liquidity);
 assert.equal(x.candidates.length,1);
 assert.equal(x.candidates[0].buyVenue,'orca');
 assert.equal(x.unmatchedReverseLegs,1);
});
test('invalid or missing legs never turn into fabricated opportunities',()=>{
 assert.equal(combineLiveQuotes([ray],[],0.02,liquidity).candidates.length,0);
 assert.equal(combineLiveQuotes([],[orcaBuy],0.02,liquidity).candidates.length,0);
 const x=combineLiveQuotes([ray],[{...orcaBuy,outputRaw:'0'}],0.02,liquidity);
 assert.equal(x.candidates.length,0);
 assert.equal(x.failed,1);
});
test('event-updated quote still obeys independent source timestamps',()=>{
 const aged={...orcaBuy,observedAt:new Date(Date.parse(ts)-15000).toISOString()};
 const result=combineLiveQuotes([ray],[aged],0.02,liquidity);
 const assessed=assessRoutes(result.candidates,{
  maxAgeMs:10000,maxGapMs:3000,maxSlotSkew:12,minLiquidityUsd:10000
 },Date.parse(ts)+500);
 assert.equal(assessed.total,1);
 assert.equal(assessed.comparable,0);
 assert.ok(assessed.excludedCandidates[0].freshnessReasons.includes('quote_gap_exceeded'));
});
