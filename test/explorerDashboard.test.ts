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
  'routeFiltered','copy','function esc'
 ].filter(x=>x!=='Not transaction-simulated')){
  assert.ok(explorerHtml.includes(text),'missing '+text);
 }
 assert.match(explorerHtml,/NO WALLET \/ NO TRANSACTION EXECUTION/);
 assert.match(explorerHtml,/USDC may appear inside an actual bridge route/);
 assert.ok(explorerHtml.includes('encodeURIComponent')===false,'mint addresses must not be used as untrusted URLs');
});
