import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey,type Connection,type ParsedTransactionWithMeta} from '@solana/web3.js';
import {ChainHistorySampler,chooseEvidenceSeedPools} from '../src/c3ChainHistory.js';
import {ORCA_WHIRLPOOL,RAYDIUM_CLMM,RAYDIUM_AMM_V4} from '../src/routes.js';

const poolA=new PublicKey(Buffer.alloc(32,16)).toBase58();
const poolB=new PublicKey(Buffer.alloc(32,17)).toBase58();
const poolC=new PublicKey(Buffer.alloc(32,18)).toBase58();

test('C3A selects high-liquidity pools across different DEX programs',()=>{
 const list=[
  {address:poolA,owner:RAYDIUM_AMM_V4,liquidityUsd:900000},
  {address:poolB,owner:RAYDIUM_CLMM,liquidityUsd:400000},
  {address:poolC,owner:ORCA_WHIRLPOOL,liquidityUsd:150000},
  {address:'other',owner:'not-a-supported-program',liquidityUsd:10000000}
 ];
 assert.deepEqual(chooseEvidenceSeedPools(list,3),[poolA,poolB,poolC]);
 assert.deepEqual(chooseEvidenceSeedPools(list,2),[poolA,poolB]);
 assert.deepEqual(chooseEvidenceSeedPools(list,0),[]);
});
async function finished(sampler:ChainHistorySampler){
 for(let i=0;i<80;i++){
  if(!sampler.snapshot().running)return;
  await new Promise<void>(resolve=>setTimeout(resolve,10));
 }
 throw Error('Timed out waiting for mock historical sample');
}
test('C3A samples real RPC transaction shape on demand, deduplicates and journals safely',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sol-arbs-c3-'));
 try{
  let calls=0,fetches=0;
  const conn={
   getSignaturesForAddress:async (_pool:PublicKey)=>{calls++;return [
    {signature:'signature-a',slot:100}, {signature:'signature-b',slot:99}
   ];},
   getParsedTransaction:async (signature:string):Promise<ParsedTransactionWithMeta|null>=>{
    fetches++;
    return {slot:100,blockTime:1780000000,
     transaction:{signatures:[signature],message:{
      accountKeys:[{pubkey:new PublicKey(Buffer.alloc(32,8)),signer:true,writable:true}],
      instructions:[],recentBlockhash:'hash'
     }},
     meta:{err:null,fee:5000,preBalances:[1000000],postBalances:[995000],
      preTokenBalances:[],postTokenBalances:[],logMessages:[],innerInstructions:[]}
    } as unknown as ParsedTransactionWithMeta;
   }
  } as unknown as Connection;
  const config={maxSeedPools:3,signaturesPerPool:3,maxTransactions:2,cooldownMs:0,maxRows:50};
  const sampler=new ChainHistorySampler(conn,dir,config);
  await sampler.initialize();
  assert.equal(sampler.snapshot().summary.sampledTransactions,0);
  const accepted=sampler.request([poolA,poolB]);
  assert.equal(accepted.accepted,true);
  const concurrent=sampler.request([poolA]);
  assert.equal(concurrent.accepted,false);
  await finished(sampler);
  let state=sampler.snapshot();
  assert.equal(state.progress.signaturesDiscovered,2);
  assert.equal(state.progress.transactionsAnalyzed,2);
  assert.equal(state.summary.sampledTransactions,2);
  assert.equal(state.summary.verifiedProfitableTransactions,0);
  assert.equal(calls,2);
  assert.equal(fetches,2);
  assert.equal(state.observations[0].profitability,'unverified');
  assert.equal(state.observations[0].netBusinessProfitUsd,null);
  const content=await readFile(join(dir,'c3-onchain-evidence.jsonl'),'utf8');
  assert.equal(content.trim().split('\n').length,2);
  assert.equal(content.includes('https://'),false,'No RPC URLs or API secrets should be journaled');
  assert.equal(sampler.request([poolA]).accepted,true);
  await finished(sampler);
  assert.equal(fetches,2,'previously analyzed signatures should not be fetched again');
  const reloaded=new ChainHistorySampler(conn,dir,config);
  await reloaded.initialize();
  state=reloaded.snapshot();
  assert.equal(state.summary.sampledTransactions,2);
  assert.equal(state.observations[0].readOnly,true);
 }finally{
  await rm(dir,{recursive:true,force:true});
 }
});
test('C3A rejects scans without pools and invalid public keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sol-arbs-c3-empty-'));
 try{
  const sampler=new ChainHistorySampler({} as Connection,dir,
   {maxSeedPools:2,signaturesPerPool:2,maxTransactions:2,cooldownMs:0,maxRows:5});
  await sampler.initialize();
  assert.equal(sampler.request([]).accepted,false);
  assert.equal(sampler.request(['not-a-pubkey']).accepted,false);
  assert.equal(sampler.snapshot().completedRuns,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('C3A accepts version 1 RPC history rather than repeating unsupported version errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sol-arbs-c3-v1-'));
 try{
  let requestedVersion:number|undefined;
  const conn={
   getSignaturesForAddress:async()=>[{signature:'v1-signature',slot:12345}],
   getParsedTransaction:async (_signature:string,config?:{maxSupportedTransactionVersion?:number})=>{
    requestedVersion=config?.maxSupportedTransactionVersion;
    if(requestedVersion===undefined||requestedVersion<1)
     throw new Error('Transaction version (1) is not supported by the requesting client.');
    return {
     slot:12345,blockTime:1780000000,
     transaction:{signatures:['v1-signature'],message:{
      accountKeys:[{pubkey:new PublicKey(Buffer.alloc(32,24)),signer:true,writable:true}],
      instructions:[],recentBlockhash:'hash'
     }},
     meta:{err:null,fee:5000,preBalances:[1000000],postBalances:[995000],
      preTokenBalances:[],postTokenBalances:[],logMessages:[],innerInstructions:[]}
    } as unknown as ParsedTransactionWithMeta;
   }
  } as unknown as Connection;
  const sampler=new ChainHistorySampler(conn,dir,{
   maxSeedPools:1,signaturesPerPool:1,maxTransactions:1,cooldownMs:0,maxRows:5
  });
  await sampler.initialize();
  assert.equal(sampler.request([poolA]).accepted,true);
  await finished(sampler);
  const state=sampler.snapshot();
  assert.equal(requestedVersion,1,'Solana v1 transaction history should be requested explicitly');
  assert.equal(state.progress.transactionsAnalyzed,1);
  assert.equal(state.progress.errors,0);
  assert.equal(state.observations[0].signature,'v1-signature');
  assert.equal(state.observations[0].profitability,'unverified');
 }finally{await rm(dir,{recursive:true,force:true})}
});
