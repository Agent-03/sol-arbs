import type {ParsedTransactionWithMeta,TokenBalance} from '@solana/web3.js';
import {USDC_MINT,SOL_MINT} from './discovery.js';
import {ORCA_WHIRLPOOL,RAYDIUM_AMM_V4,RAYDIUM_CLMM} from './routes.js';

const DEX_PROGRAMS:Readonly<Record<string,string>>={
 [ORCA_WHIRLPOOL]:'Orca Whirlpool',
 [RAYDIUM_AMM_V4]:'Raydium AMM V4',
 [RAYDIUM_CLMM]:'Raydium CLMM',
 // Discovery-only attribution for these programs. No local quote adapter implied.
 'CPMMoo8L3F4NbTegBCKVNfKbApxMwdxq1SqBNhqf9K':'Raydium CPMM',
 'LBUZKhRxPF3XUpBCjp4YzTKgLccmNf4V5nQVJhcJj6H':'Meteora DLMM',
 'Eo7WjKq67rjJQSXUUGAjf6HHBeBVJDF4SYvN3GHnW8n':'Meteora DAMM V1'
};

export type ChainEvidenceStatus=
 'failed_transaction'|'no_detected_multi_swap'|'fee_payer_unattributed'|
 'inventory_open'|'usdc_nonpositive'|'positive_usdc_before_sol_costs';

export type ChainEvidence={
 signature:string;seedPool:string;slot:number;blockTime:string|null;
 observedAt:string;feePayer:string;status:ChainEvidenceStatus;
 dexInvocations:number;dexPrograms:string[];dexSequence:string[];
 touchedMints:string[];tokenTransferInstructions:number;
 feePayerUsdcDeltaRaw:string|null;feePayerUsdcDeltaUsd:number|null;
 feePayerSolDeltaLamports:string|null;networkFeeLamports:number;
 otherFeePayerMintDeltas:Record<string,string>;
 evidenceIssues:string[];
 profitability:'unverified';jitoTipLamports:null;netBusinessProfitUsd:null;
 readOnly:true;
};

type TokenState={amount:bigint;owner:string|null;mint:string;accountIndex:number};
function amountRaw(x:TokenBalance):bigint|null{
 const raw=x.uiTokenAmount?.amount;
 if(typeof raw!=='string'||!/^\d+$/.test(raw))return null;
 try{return BigInt(raw)}catch{return null}
}
function states(items:readonly TokenBalance[]|null|undefined):Map<string,TokenState>{
 const out=new Map<string,TokenState>();
 for(const item of items??[]){
  const amount=amountRaw(item);
  if(amount===null)continue;
  const key=item.accountIndex+':'+item.mint;
  out.set(key,{amount,owner:item.owner||null,mint:item.mint,accountIndex:item.accountIndex});
 }
 return out;
}
function tokenTransferCount(tx:ParsedTransactionWithMeta):number{
 let n=0;
 const groups=[
  tx.transaction.message.instructions,
  ...(tx.meta?.innerInstructions?.map(group=>group.instructions)??[])
 ];
 for(const group of groups)for(const inst of group){
  if(!('parsed'in inst))continue;
  const parsed=inst.parsed;
  if(parsed&&typeof parsed==='object'){
   const type=(parsed as {type?:unknown}).type;
   if(type==='transfer'||type==='transferChecked')n++;
  }
 }
 return n;
}
function programInvocations(tx:ParsedTransactionWithMeta){
 const programs:string[]=[];
 // Log order reflects actual nested CPI execution. Top-level instructions
 // do not establish that a DEX call actually executed successfully.
 for(const log of tx.meta?.logMessages??[]){
  const match=/^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[\d+\]/.exec(log);
  if(match&&DEX_PROGRAMS[match[1]])programs.push(DEX_PROGRAMS[match[1]]);
 }
 return programs;
}
function feePayerFromTransaction(tx:ParsedTransactionWithMeta):string{
 const entry=tx.transaction.message.accountKeys[0];
 return entry?entry.pubkey.toBase58():'';
}

/** Evidence extractor only. It never infers complete swap paths from logs,
 * nor converts SOL fees/tips into USDC without historical SOL/USDC prices.
 * A positive USDC balance delta is NOT verified net trading profit.
 */
export function analyzeChainTransaction(
 signature:string,seedPool:string,tx:ParsedTransactionWithMeta,
 observedAt=new Date().toISOString()
):ChainEvidence{
 const feePayer=feePayerFromTransaction(tx);
 const before=states(tx.meta?.preTokenBalances);
 const after=states(tx.meta?.postTokenBalances);
 const keys=new Set([...before.keys(),...after.keys()]);
 const byMint=new Map<string,bigint>();
 let attributable=0,missingOwners=0;
 const touchedMints=new Set<string>();
 for(const key of keys){
  const pre=before.get(key),post=after.get(key),sample=pre??post!;
  touchedMints.add(sample.mint);
  const owner=post?.owner??pre?.owner;
  if(owner===null){missingOwners++;continue;}
  // Owner switches require an account-level explanation; exclude ambiguous
  // ownership changes rather than treating the entire balance as profit.
  if(pre?.owner&&post?.owner&&pre.owner!==post.owner){missingOwners++;continue;}
  if(owner!==feePayer)continue;
  attributable++;
  byMint.set(sample.mint,(byMint.get(sample.mint)??0n)+(post?.amount??0n)-(pre?.amount??0n));
 }
 const usdc=byMint.has(USDC_MINT)?byMint.get(USDC_MINT)!:null;
 const nativeIndex=0;
 const preSol=tx.meta?.preBalances?.[nativeIndex],postSol=tx.meta?.postBalances?.[nativeIndex];
 const nativeDelta=typeof preSol==='number'&&typeof postSol==='number'
  ?BigInt(postSol)-BigInt(preSol):null;
 const other=Object.fromEntries([...byMint.entries()]
  .filter(([mint,delta])=>mint!==USDC_MINT&&delta!==0n)
  .map(([mint,delta])=>[mint,delta.toString()]));
 const dexSequence=programInvocations(tx);
 const dexPrograms=[...new Set(dexSequence)];
 const transfers=tokenTransferCount(tx);
 const issues:string[]=[];
 if(!tx.meta)issues.push('transaction_meta_missing');
 if(tx.meta?.err)issues.push('transaction_failed');
 if(!tx.meta?.logMessages?.length)issues.push('program_execution_logs_missing');
 if(dexSequence.length<2)issues.push('fewer_than_two_supported_dex_invocations');
 if(transfers<2)issues.push('insufficient_parsed_token_transfers');
 if(missingOwners)issues.push('unattributed_token_accounts');
 if(!attributable||usdc===null)issues.push('fee_payer_usdc_inventory_not_observed');
 if(Object.keys(other).length)issues.push('fee_payer_other_token_inventory_changed');
 if(nativeDelta===null)issues.push('fee_payer_native_sol_delta_unknown');
 // Conservatively avoid attributing positive USDC to closed-loop arbitrage
 // if other known token inventories or token owners are unaccounted for.
 const multiSwap=dexSequence.length>=2&&transfers>=2;
 const status:ChainEvidenceStatus=tx.meta?.err?'failed_transaction':
  !multiSwap?'no_detected_multi_swap':
  missingOwners||usdc===null?'fee_payer_unattributed':
  Object.keys(other).length?'inventory_open':
  usdc<=0n?'usdc_nonpositive':'positive_usdc_before_sol_costs';
 return {signature,seedPool,slot:tx.slot,
  blockTime:tx.blockTime?new Date(tx.blockTime*1000).toISOString():null,
  observedAt,feePayer,status,
  dexInvocations:dexSequence.length,dexPrograms,dexSequence,
  touchedMints:[...touchedMints].sort(),tokenTransferInstructions:transfers,
  feePayerUsdcDeltaRaw:usdc?.toString()??null,
  feePayerUsdcDeltaUsd:usdc===null?null:Number(usdc)/1e6,
  feePayerSolDeltaLamports:nativeDelta?.toString()??null,
  networkFeeLamports:tx.meta?.fee??0,
  otherFeePayerMintDeltas:other,evidenceIssues:issues,
  profitability:'unverified',jitoTipLamports:null,netBusinessProfitUsd:null,
  readOnly:true};
}

/** Strictly diagnostic; not a claim of winner or realized arbitrage P&L. */
export function summarizeChainEvidence(items:readonly ChainEvidence[]){
 const counts:Record<ChainEvidenceStatus,number>={
  failed_transaction:0,no_detected_multi_swap:0,fee_payer_unattributed:0,
  inventory_open:0,usdc_nonpositive:0,positive_usdc_before_sol_costs:0
 };
 for(const item of items)counts[item.status]++;
 const dexCount=new Map<string,number>();
 for(const item of items)for(const program of item.dexPrograms){
  dexCount.set(program,(dexCount.get(program)??0)+1);
 }
 return {sampledTransactions:items.length,counts,
  observedPositiveUsdcCandidates:counts.positive_usdc_before_sol_costs,
  verifiedProfitableTransactions:0,verifiedNetProfitUsd:null,
  topDexPrograms:[...dexCount].sort((a,b)=>b[1]-a[1]).slice(0,12)
   .map(([name,transactions])=>({name,transactions})),
  note:'Fee-payer token deltas are attribution-limited. SOL network fees and Jito tips are not converted to USDC; no reported transaction is certified net profitable.'};
}
