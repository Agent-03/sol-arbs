import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPoolEligibility,computeCoverage} from '../src/poolEligibility.js';
import {RAYDIUM_AMM_V4,RAYDIUM_CLMM,ORCA_WHIRLPOOL} from '../src/routes.js';
import type {DiscoveredPool} from '../src/discovery.js';
import type {LiveRaydiumSnapshot} from '../src/liveRaydium.js';
import type {OrcaStatus,OrcaQuote} from '../src/orca.js';
import type {ClmmHealth,ClmmQuote} from '../src/clmm.js';
const now=Date.parse('2026-11-22T06:30:00.000Z');
const timestamp=new Date(now-2000).toISOString();
const pools:DiscoveredPool[]=[
 {address:'ray-high',venue:'raydium',owner:RAYDIUM_AMM_V4,liquidityUsd:500000},
 {address:'ray-low',venue:'raydium',owner:RAYDIUM_AMM_V4,liquidityUsd:2000},
 {address:'clmm-high',venue:'raydium',owner:RAYDIUM_CLMM,liquidityUsd:1000000},
 {address:'clmm-other',venue:'raydium',owner:RAYDIUM_CLMM,liquidityUsd:100000},
 {address:'orca-high',venue:'orca',owner:ORCA_WHIRLPOOL,liquidityUsd:900000},
 {address:'other',venue:'raydium',owner:'unknown',liquidityUsd:10000}
];
const ray:LiveRaydiumSnapshot={
 status:'ok',poolCount:1,readyPools:1,subscriptions:3,events:3,localRecomputations:4,
 reconciliations:1,quotes:[{pool:'ray-high',direction:'USDC_TO_SOL',
  inputRaw:'5000000',outputRaw:'70000000',slot:12,vaultSlot:12,observedAt:timestamp,
  feeNumerator:'25',feeDenominator:'10000',reserveInRaw:'1000000000',reserveOutRaw:'10000000000',
  classification:'indicative_non_executable'}],
 errors:[],poolReasons:{},progress:{totalPools:1,completedPools:1,quotesProduced:1}
};
const orcaLeg:OrcaQuote={
 pool:'orca-high',direction:'USDC_TO_SOL',inputRaw:'5000000',outputRaw:'71000000',
 feeRaw:'1000',observedAt:timestamp,poolSlot:12,classification:'indicative_non_executable',
 tickArraysObservedAt:timestamp,tickArraySlot:null
};
const orca:OrcaStatus={status:'ok',quotedLegs:[orcaLeg],routeCandidates:[],errors:[],
 orcaPools:1,quoteState:'fresh',freshLegs:1,expiredLegs:0,poolFreshness:[]};
const clmmQuote:ClmmQuote={pool:'clmm-high',direction:'USDC_TO_SOL',inputRaw:'5000000',
 outputRaw:'73000000',observedAt:timestamp,computedAt:timestamp,poolSlot:12,
 feeRaw:'1000',tickArraysObservedAt:timestamp,tickArraySlot:null,
 quoteModel:'raydium_clmm_sdk_tick_array',snapshotIntegrity:'multi_rpc_context_unverified'};
const clmm:ClmmHealth={
 status:'ok',selectedPools:1,readyPools:1,quotes:[clmmQuote],
 errors:[],scans:1,perPool:[{pool:'clmm-high',status:'fresh',lastObservedAt:timestamp,ageMs:2000,tickArrays:5,slot:12}]
};
test('pool eligibility reports each exact reason rather than hiding CLMM or low-TVL pools',()=>{
 const list=classifyPoolEligibility(pools,ray,orca,clmm,10000,1,15000,now);
 const state=(key:string)=>list.find(p=>p.address===key)!;
 assert.equal(state('ray-high').state,'active');
 assert.equal(state('ray-low').state,'excluded');
 assert.match(state('ray-low').reason,/liquidity below/);
 assert.equal(state('clmm-high').state,'active');
 assert.equal(state('clmm-high').tickSlotVerified,false);
 assert.equal(state('clmm-other').state,'not_selected');
 assert.equal(state('orca-high').state,'active');
 assert.equal(state('other').state,'unsupported');
});
test('coverage denominators count eligible Raydium AMM/CLMM against Orca',()=>{
 const list=classifyPoolEligibility(pools,ray,orca,clmm,10000,1,15000,now);
 const result=computeCoverage(list,3,4,3,1,2);
 assert.equal(result.supportedEligiblePools,3);
 assert.equal(result.activeQuotePools,3);
 assert.equal(result.theoreticalComparisons,12);
 assert.equal(result.completeEstimates,4);
 assert.equal(result.freshnessQualified,3);
 assert.equal(result.comparisonCoveragePct,25);
});
test('expired quote has not become fresh just because monitoring is active',()=>{
 const staleTime=new Date(now-60000).toISOString();
 const stale:OrcaStatus={...orca,quotedLegs:[{...orcaLeg,observedAt:staleTime}],quoteState:'expired'};
 const list=classifyPoolEligibility(pools,ray,stale,clmm,10000,1,15000,now);
 assert.equal(list.find(p=>p.address==='orca-high')?.state,'expired');
});
