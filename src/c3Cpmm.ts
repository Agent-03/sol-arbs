import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {amountOutExactInput} from './ammV4.js';

export const RAYDIUM_CPMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const SPL_TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CPMM_KEY=new PublicKey(RAYDIUM_CPMM);
export const CPMM_VAULT_AUTHORITY=PublicKey.findProgramAddressSync(
 [Buffer.from('vault_and_lp_mint_auth_seed')],CPMM_KEY)[0].toBase58();
const discriminator=(name:string)=>createHash('sha256')
 .update('account:'+name).digest().subarray(0,8);
const POOL_DISC=discriminator('PoolState'),CONFIG_DISC=discriminator('AmmConfig');
const key=(data:Buffer,at:number)=>new PublicKey(data.subarray(at,at+32)).toBase58();
const u64=(data:Buffer,at:number)=>data.readBigUInt64LE(at);
const LIMIT=1000000n;
export type CpmmPoolState={
 config:string;vaultA:string;vaultB:string;mintA:string;mintB:string;
 tokenProgramA:string;tokenProgramB:string;
 protocolFeesA:bigint;protocolFeesB:bigint;fundFeesA:bigint;fundFeesB:bigint;
 creatorFeesA:bigint;creatorFeesB:bigint;
 creatorFeeOn:0|1|2;creatorFeeEnabled:boolean;
 openTime:bigint;status:number;
};
export type CpmmFeeConfig={tradeFeeRate:bigint;creatorFeeRate:bigint};

/** Raydium cp-swap Anchor PoolState (637 bytes).
 * Reject unexpected data versions, disabled swaps, unknown creator modes,
 * and extension-bearing token programs rather than returning fictitious quotes.
 */
export function decodeCpmmPool(data:Buffer,nowSeconds=Math.floor(Date.now()/1000)):CpmmPoolState{
 if(data.length!==637||!data.subarray(0,8).equals(POOL_DISC))
  throw new Error('Unsupported Raydium CPMM PoolState layout or discriminator');
 if((data[329]&4)!==0)throw new Error('CPMM swaps disabled');
 if(u64(data,373)>BigInt(nowSeconds))throw new Error('CPMM pool not yet open');
 const creatorFeeOn=data[389];
 if(creatorFeeOn!==0&&creatorFeeOn!==1&&creatorFeeOn!==2)
  throw new Error('Unknown CPMM creator fee mode');
 if(data[390]!==0&&data[390]!==1)throw new Error('Invalid CPMM creator fee flag');
 const tokenProgramA=key(data,232),tokenProgramB=key(data,264);
 if(tokenProgramA!==SPL_TOKEN_PROGRAM||tokenProgramB!==SPL_TOKEN_PROGRAM)
  throw new Error('CPMM Token-2022/transfer fee unsupported in C3 graph');
 return {config:key(data,8),vaultA:key(data,72),vaultB:key(data,104),
  mintA:key(data,168),mintB:key(data,200),tokenProgramA,tokenProgramB,
  status:data[329],openTime:u64(data,373),
  protocolFeesA:u64(data,341),protocolFeesB:u64(data,349),
  fundFeesA:u64(data,357),fundFeesB:u64(data,365),
  creatorFeeOn:creatorFeeOn as 0|1|2,creatorFeeEnabled:data[390]===1,
  creatorFeesA:u64(data,397),creatorFeesB:u64(data,405)};
}
/** Current on-chain AmmConfig (236 bytes), including creator fee rate.
 * Parse config from the account, not potentially stale REST metadata.
 */
export function decodeCpmmConfig(data:Buffer):CpmmFeeConfig{
 if(data.length!==236||!data.subarray(0,8).equals(CONFIG_DISC))
  throw new Error('Unsupported CPMM AmmConfig layout or discriminator');
 const tradeFeeRate=u64(data,12),creatorFeeRate=u64(data,108);
 if(tradeFeeRate>=LIMIT||creatorFeeRate>=LIMIT||tradeFeeRate+creatorFeeRate>=LIMIT)
  throw new Error('Invalid CPMM fee config rates');
 return {tradeFeeRate,creatorFeeRate};
}
export function cpmmEffectiveReserves(
 state:CpmmPoolState,rawA:bigint,rawB:bigint):{reserveA:bigint;reserveB:bigint}{
 const a=rawA-state.protocolFeesA-state.fundFeesA-state.creatorFeesA;
 const b=rawB-state.protocolFeesB-state.fundFeesB-state.creatorFeesB;
 if(a<=0n||b<=0n)throw new Error('CPMM effective reserves exhausted');
 return {reserveA:a,reserveB:b};
}
const ceil=(x:bigint,y:bigint)=>(x+y-1n)/y;
/** Integer fee math: trade fee always on input, creator fee on designated side.
 * Mirrors Raydium CPMM's documented fee rounding; returns an indicative
 * reserve-based result, NOT an independent executable swap simulation.
 */
export function cpmmAmountOut(input:bigint,reserveIn:bigint,reserveOut:bigint,
 tradeFeeRate:bigint,creatorFeeRate:bigint,creatorFeeOn:0|1|2,
 inputIsA:boolean):bigint{
 if(input<=0n||reserveIn<=0n||reserveOut<=0n||
  tradeFeeRate<0n||creatorFeeRate<0n||tradeFeeRate+creatorFeeRate>=LIMIT||
  (creatorFeeOn!==0&&creatorFeeOn!==1&&creatorFeeOn!==2))
  throw new Error('Invalid CPMM quote parameters');
 const creatorOnInput=creatorFeeOn===0||
  (creatorFeeOn===1&&inputIsA)||(creatorFeeOn===2&&!inputIsA);
 const inputRate=tradeFeeRate+(creatorOnInput?creatorFeeRate:0n);
 const adjusted=input-ceil(input*inputRate,LIMIT);
 if(adjusted<=0n)return 0n;
 const swapped=adjusted*reserveOut/(reserveIn+adjusted);
 if(creatorOnInput||creatorFeeRate===0n)return swapped;
 const creatorOutputFee=ceil(swapped*creatorFeeRate,LIMIT);
 return swapped>creatorOutputFee?swapped-creatorOutputFee:0n;
}
