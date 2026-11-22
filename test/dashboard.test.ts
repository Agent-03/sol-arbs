import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {dashboardHtml} from '../src/dashboard.js';

test('live dashboard inline JavaScript parses successfully',()=>{
 const script=dashboardHtml.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(script,'dashboard script must exist');
 assert.doesNotThrow(()=>new Script(script[1],{filename:'sol-arb-dashboard.js'}));
});
test('dashboard exposes core monitoring controls and real backend routes',()=>{
 for(const item of ['id="scan-btn"','id="discover-btn"','/api/dashboard','/api/actions/',
  'Excluded','Live detection engine','RPC network','Local evaluation history',
  'Usable market coverage','Pool eligibility','orca-continuity','coverage-complete','clmm-state','orca-mode','orca-timing','Fast diagnostic',
  'Phase C1','id="c1-watched"','id="c1-ws"','id="c1-ready"','/api/market-data']){
  assert.ok(dashboardHtml.includes(item),'missing '+item);
 }
});
