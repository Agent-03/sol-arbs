import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCandidates, classifyPool, constantProductAmountOut, ORCA_WHIRLPOOL, RAYDIUM_AMM_V4, RAYDIUM_CLMM} from '../src/routes.js';
import type {DiscoveredPool} from '../src/discovery.js';
const pools:DiscoveredPool[]=[
 {address:'RayPool',owner:RAYDIUM_AMM_V4,venue:'raydium',liquidityUsd:100000},
 {address:'OrcaPool',owner:ORCA_WHIRLPOOL,venue:'orca',liquidityUsd:200000},
 {address:'RayClmm',owner:RAYDIUM_CLMM,venue:'raydium',liquidityUsd:300000},
];
test('program owners classified using known on-chain DEX IDs',()=>{
 assert.equal(classifyPool(pools[0]).program,'raydium_amm_v4');
 assert.equal(classifyPool(pools[1]).program,'orca_whirlpool');
 assert.equal(classifyPool(pools[2]).program,'raydium_clmm');
});
test('create only distinct cross-venue routes with no executable claims',()=>{
 const {candidates,rejectedPools}=buildCandidates(pools);
 assert.equal(rejectedPools,0);
 assert.equal(candidates.length,4);
 assert.ok(candidates.every(c=>c.buyVenue!==c.sellVenue));
 assert.ok(candidates.every(c=>c.buyPool!==c.sellPool));
 assert.ok(candidates.every(c=>c.status==='requires_exact_quoters'));
});
test('reject owner/venue mismatches',()=>{
 const {candidates,rejectedPools}=buildCandidates([...pools,{address:'Unknown',owner:'unknown',venue:'orca'}]);
 assert.equal(rejectedPools,1);
 assert.ok(candidates.every(c=>c.buyPool!=='Unknown'&&c.sellPool!=='Unknown'));
});
test('pool ordering and limits are deterministic',()=>{
 const a=buildCandidates(pools,2).candidates;
 const b=buildCandidates([...pools].reverse(),2).candidates;
 assert.deepEqual(a,b);
});
test('reference integer CPMM math is monotone and fee reduces output',()=>{
 const noFee=constantProductAmountOut(1000n,1000000n,1000000n,0n,10000n);
 const withFee=constantProductAmountOut(1000n,1000000n,1000000n,25n,10000n);
 assert.equal(noFee,999n);
 assert.ok(withFee<=noFee);
 assert.ok(constantProductAmountOut(2000n,1000000n,1000000n,25n,10000n)>withFee);
 assert.throws(()=>constantProductAmountOut(10n,100n,100n,10000n,10000n));
});
