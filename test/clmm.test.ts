import test from 'node:test';
import assert from 'node:assert/strict';
import {isClmmPair,validateClmmQuoteOutput} from '../src/clmm.js';
import {SOL_MINT,USDC_MINT} from '../src/discovery.js';
test('CLMM adapter accepts only canonical SOL/USDC mints',()=>{
 assert.equal(isClmmPair(USDC_MINT,SOL_MINT),true);
 assert.equal(isClmmPair(SOL_MINT,USDC_MINT),true);
 assert.equal(isClmmPair(SOL_MINT,SOL_MINT),false);
 assert.equal(isClmmPair('another-token',USDC_MINT),false);
});
test('CLMM quote validation rejects zero or malformed SDK estimates',()=>{
 assert.equal(validateClmmQuoteOutput(1000000n,'50000000'),50000000n);
 assert.throws(()=>validateClmmQuoteOutput(1000000n,'0'),/Zero/);
 assert.throws(()=>validateClmmQuoteOutput(0n,'100'),/Malformed/);
 assert.throws(()=>validateClmmQuoteOutput(1000000n,'not a BN'),/Malformed/);
 assert.throws(()=>validateClmmQuoteOutput(1000000n,'-1'),/Malformed/);
});
