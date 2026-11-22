import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type ParsedTransactionWithMeta} from '@solana/web3.js';
import {USDC_MINT,SOL_MINT} from '../src/discovery.js';
import {ORCA_WHIRLPOOL,RAYDIUM_CLMM} from '../src/routes.js';
import {analyzeChainTransaction,summarizeChainEvidence} from '../src/c3ArbitrageEvidence.js';

const feePayer=new PublicKey(Buffer.alloc(32,21));
const swapLogs=[
 'Program '+ORCA_WHIRLPOOL+' invoke [1]',
 'Program '+ORCA_WHIRLPOOL+' success',
 'Program '+RAYDIUM_CLMM+' invoke [1]',
 'Program '+RAYDIUM_CLMM+' success'
];
function tokenBalance(accountIndex:number,mint:string,owner:string,amount:string){
 return {accountIndex,mint,owner,uiTokenAmount:{
  amount,decimals:mint===USDC_MINT?6:9,
  uiAmount:null,uiAmountString:'0'
 }};
}
function fixture(opts?:{
 usdcDelta?:bigint;solDelta?:bigint;otherDelta?:bigint;
 missingOwner?:boolean;failed?:boolean;singleDex?:boolean;transfers?:number;
}):ParsedTransactionWithMeta{
 const owner=opts?.missingOwner?undefined:feePayer.toBase58();
 const usdcBefore=100000000n,usdcAfter=usdcBefore+(opts?.usdcDelta??5000000n);
 const solBefore=900000000n,solAfter=solBefore+(opts?.otherDelta??0n);
 const make=(idx:number,mint:string,raw:bigint)=>tokenBalance(idx,mint,owner as string,raw.toString());
 const logs=opts?.singleDex?swapLogs.slice(0,2):swapLogs;
 return {
  slot:777,blockTime:1780000000,
  transaction:{signatures:['fake-signature'],message:{
   accountKeys:[{pubkey:feePayer,signer:true,writable:true}],instructions:[],recentBlockhash:'foo'
  }},
  meta:{
   err:opts?.failed?{InstructionError:[1,'Custom']} : null,
   fee:12000,preBalances:[1000000000],postBalances:[1000000000+Number(opts?.solDelta??-12000n)],
   preTokenBalances:[make(1,USDC_MINT,usdcBefore),make(2,SOL_MINT,solBefore)],
   postTokenBalances:[make(1,USDC_MINT,usdcAfter),make(2,SOL_MINT,solAfter)],
   logMessages:logs,
   innerInstructions:[{index:0,instructions:Array.from({length:opts?.transfers??3},()=>({
    programId:new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    parsed:{type:'transferChecked',info:{}}
   }))}],
  }
 } as unknown as ParsedTransactionWithMeta;
}
test('C3A reports fee-payer positive USDC inventory, never verified net profit',()=>{
 const e=analyzeChainTransaction('sample-tx','pool-A',fixture(),'2026-11-22T00:00:00Z');
 assert.equal(e.status,'positive_usdc_before_sol_costs');
 assert.equal(e.feePayerUsdcDeltaRaw,'5000000');
 assert.equal(e.feePayerUsdcDeltaUsd,5);
 assert.equal(e.dexInvocations,2);
 assert.deepEqual(e.dexPrograms,['Orca Whirlpool','Raydium CLMM']);
 assert.equal(e.networkFeeLamports,12000);
 assert.equal(e.feePayerSolDeltaLamports,'-12000');
 assert.equal(e.jitoTipLamports,null);
 assert.equal(e.netBusinessProfitUsd,null);
 assert.equal(e.profitability,'unverified');
 assert.equal(summarizeChainEvidence([e]).verifiedProfitableTransactions,0);
});
test('C3A does not classify inventory left in WSOL as a closed cycle',()=>{
 const e=analyzeChainTransaction('other','pool-A',fixture({otherDelta:123456n}));
 assert.equal(e.status,'inventory_open');
 assert.deepEqual(e.otherFeePayerMintDeltas,{[SOL_MINT]:'123456'});
});
test('C3A requires multi-swap and parsed token transfer evidence',()=>{
 assert.equal(analyzeChainTransaction('single','pool',fixture({singleDex:true})).status,'no_detected_multi_swap');
 assert.equal(analyzeChainTransaction('no-transfers','pool',fixture({transfers:0})).status,'no_detected_multi_swap');
});
test('C3A treats missing token-account ownership as unattributed, not profit',()=>{
 const e=analyzeChainTransaction('unknown','pool',fixture({missingOwner:true}));
 assert.equal(e.status,'fee_payer_unattributed');
 assert.equal(e.feePayerUsdcDeltaRaw,null);
 assert.ok(e.evidenceIssues.includes('unattributed_token_accounts'));
});
test('C3A failed transactions override any apparent balance delta',()=>{
 const e=analyzeChainTransaction('failed','pool',fixture({failed:true}));
 assert.equal(e.status,'failed_transaction');
 assert.equal(e.netBusinessProfitUsd,null);
});
test('C3A negative USDC changes are never counted as winners',()=>{
 const e=analyzeChainTransaction('loss','pool',fixture({usdcDelta:-2000000n}));
 assert.equal(e.status,'usdc_nonpositive');
 assert.equal(e.feePayerUsdcDeltaUsd,-2);
 const summary=summarizeChainEvidence([e]);
 assert.equal(summary.observedPositiveUsdcCandidates,0);
 assert.equal(summary.verifiedNetProfitUsd,null);
});
