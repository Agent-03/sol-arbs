import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {explorerHtml} from '../src/explorerDashboard.js';

test('C3D radar is valid HTML with parseable inline JavaScript',()=>{
 assert.match(explorerHtml,/<!doctype html>/i);
 const match=explorerHtml.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(match,'C3D radar must have inline application script');
 assert.doesNotThrow(()=>new Script(match[1],{filename:'solarb-c3d-dashboard.js'}));
});

test('root and terminal use the new wSOL-first dashboard, not stale USDC-first labels',()=>{
 assert.match(explorerHtml,/C3D/);
 assert.match(explorerHtml,/BASE · wSOL/);
 assert.match(explorerHtml,/Live wSOL Opportunity Radar/);
 assert.match(explorerHtml,/wSOL → Token → wSOL/);
 assert.doesNotMatch(explorerHtml,/>Route Estimates</);
 assert.doesNotMatch(explorerHtml,/USDC → SOL → USDC route observations/);
 assert.doesNotMatch(explorerHtml,/SOL \/ USDC<\/span>/);
});

test('C3D radar displays dynamic tokens, cycle counts, SOL sizes and dual RPC health',()=>{
 for(const text of [
  'Token Discovery','Pool Coverage','RPC Network',
  'id="metricTokens"','id="metricPools"','id="metricEligible"',
  'id="metricTwo"','id="metricThree"','id="metricRpc"',
  'id="view-radar"','id="view-tokens"','id="view-coverage"','id="view-network"',
  'id="routeSearch"','id="routeLegs"','id="routeSort"','id="downloadRoutes"',
  'id="tokenSearch"','id="tokenCategory"','id="watchlist"',
  '/api/c3/graph','/api/c3/tokens','/rpc',
  'c.sizeSol','c.indicativeNetSol','g.baseAsset','t.activeTokens',
  'r.primaryAssigned','r.secondaryAssigned',
  'raydium_amm_v4','raydium_cpmm','raydium_clmm','orca_whirlpool'
 ])assert.ok(explorerHtml.includes(text),'C3D radar missing '+text);
});

test('C3D radar retains diagnostics, empty states and safe token rendering',()=>{
 for(const text of [
  'No current wSOL cycles','No matching tokens',
  'Pool state warming','SCANNER OFFLINE',
  'data-view="radar"','data-view="tokens"','data-view="coverage"',
  '/legacy','Not transaction-simulated',
  'routeFiltered','copy','var esc=function'
 ].filter(x=>x!=='Not transaction-simulated')){
  assert.ok(explorerHtml.includes(text),'missing '+text);
 }
 assert.match(explorerHtml,/NO WALLET \/ NO TRANSACTION EXECUTION/);
 assert.match(explorerHtml,/USDC may appear inside an actual bridge route/);
 assert.ok(explorerHtml.includes('encodeURIComponent')===false,'mint addresses must not be used as untrusted URLs');
});

test('C3D.2 dashboard renders mint-indexed verified multi-DEX discovery',()=>{
 for(const item of [
  'Cross-DEX Pool Registry · C3D.2','/api/c3/pools',
  'Verified DEX pools','Tokens with 2+ pools','Cross-DEX pair matches',
  'Two-leg pairs quote-ready','id="poolSearch"','id="poolFilter"',
  'id="registryTable"','id="registryMeteora"','id="registryPump"',
  'id="registryRaydium"','id="registryOrca"',
  'function renderPoolRegistry','data-pool-token','poolRegistry.tokens',
  'protocol_quote_adapter_not_yet_implemented'
 ].filter(x=>x!=='poolRegistry.tokens'&&x!=='protocol_quote_adapter_not_yet_implemented')){
  assert.ok(explorerHtml.includes(item),'missing '+item);
 }
 assert.match(explorerHtml,/Meteora DLMM quotes are active when fresh/);
 assert.match(explorerHtml,/LIVE · C3D.4/);
 assert.match(explorerHtml,/var esc=function/,'all untrusted mints and venue strings must be escaped');
});

test('C3D.4 local DLMM and Orca readiness diagnostics surface in the radar',()=>{
 for(const term of [
  'Meteora DLMM local quote readiness','id="dlmmTable"',
  'id="healthDlmm"','DLMM SDK ready / mapped',
  'graph&&graph.dlmm','dlrows.map','Fresh local SDK quote state',
  'LIVE · C3D.4.3'
 ])assert.ok(explorerHtml.includes(term),'missing '+term);
});

test('C3D.4.1 radar exposes DLMM freshness, recovery and scheduler health',()=>{
 for(const label of ['id="dlmmCadence"','id="dlmmChecks"',
  'id="dlmmRecoveries"','id="dlmmOldest"','id="dlmmRefreshStatus"',
  'dl.refreshConcurrency','dl.refreshBudget','dl.reasonCounts',
  'p.oldestAgeMs','p.refreshFailures','LIVE · C3D.4.3']){
  assert.ok(explorerHtml.includes(label),'C3D.4.1 missing '+label);
 }
});

test('C3D.4.2 dashboard exposes physical timeout locks and recovery latency',()=>{
 for(const term of [
  'id="dlmmDeadlineStatus"','dl.schedulerTicks','dl.dispatchedLastTick',
  'dl.outstandingRpcReads','dl.oldestOutstandingRpcMs','dl.rpcTimedOut',
  'dl.rpcLateSettled','dl.partialRefreshes','dl.refreshDurationMsP95',
  'dl.reindexInFlight','dl.skippedCapacity','p.continuousReadyMs',
  'LIVE · C3D.4.3'
 ])assert.ok(explorerHtml.includes(term),'missing '+term);
});

test('C3D.4.3 shows prioritized RPC lanes and local recovery telemetry',()=>{
 for(const term of [
  'LIVE · C3D.4.3','id="dlmmPriorityStatus"',
  'dl.bootstrapConcurrency','dl.bootstrapPhysicalInFlight',
  'dl.windowShiftReindexes','dl.queueDeadlineExceeded',
  'dl.transportDeadlineExceeded','dl.periodicReindexesRemoved',
  'v.pendingByPriority','v.queueWaitMsP95','v.transportMsP95',
  'v.backgroundMaxConcurrent'
 ])assert.ok(explorerHtml.includes(term),'missing '+term);
});
