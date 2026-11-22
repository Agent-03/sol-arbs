import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
test('canonical Solana key encoding',()=>{
 const key=new PublicKey('So11111111111111111111111111111111111111112');
 assert.equal(key.toBase58(),'So11111111111111111111111111111111111111112');
});
