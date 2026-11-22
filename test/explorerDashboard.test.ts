import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {explorerHtml} from '../src/explorerDashboard.js';

test('explorer includes a valid browser script',()=>{
 const match=explorerHtml.match(/<script>([\s\S]*?)<\/script>/);
 assert.ok(match,'explorer must have a script');
 assert.doesNotThrow(()=>new Script(match[1],{filename:'solarb-explorer.js'}));
});
test('explorer retains the screenshot-inspired live table interactions',()=>{
 const expected=[
  'Route Estimates','Swap Quotes','Pool Coverage','Engine Activity',
  'Transactions','data-tab="routes"','data-tab="transactions"',
  'id="query"','id="filter"','id="size"','id="csv"',
  'id="pagination"','data-sort','/api/explorer','/terminal',
  'id="c1watched"','id="c1updates"','id="c1ready"','/api/market-data','id="c2orca"','id="c2clmm"','id="c2checks"','id="validate"','/api/actions/validate'
 ];
 for(const term of expected)assert.ok(explorerHtml.includes(term),'missing '+term);
});
test('explorer clearly distinguishes simulated quotes from real Solana transactions',()=>{
 assert.match(explorerHtml,/not executed transactions/i);
 assert.match(explorerHtml,/No transaction indexer connected/i);
 assert.match(explorerHtml,/No Solana transaction signature/i);
 assert.match(explorerHtml,/No wallet/i);
});
