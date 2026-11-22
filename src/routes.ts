import type { DiscoveredPool } from './discovery.js';

export const ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
export const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

export type VenueProgram = 'orca_whirlpool' | 'raydium_amm_v4' | 'raydium_clmm' | 'unsupported';
export type RouteCandidate = {
  id: string;
  tokenPath: ['USDC', 'SOL', 'USDC'];
  buyPool: string; sellPool: string;
  buyProgram: VenueProgram; sellProgram: VenueProgram;
  buyVenue: DiscoveredPool['venue']; sellVenue: DiscoveredPool['venue'];
  buyLiquidityUsd?: number; sellLiquidityUsd?: number;
  status: 'requires_exact_quoters';
  reason: string;
};
export type PoolCapability = {
  address: string;
  venue: DiscoveredPool['venue'];
  program: VenueProgram;
  ownerProgramMatchesVenue: boolean;
  quoteStatus: 'indicative_supported' | 'not_implemented';
  liquidityUsd?: number;
};

export function identifyProgram(owner: string): VenueProgram {
  if (owner === ORCA_WHIRLPOOL) return 'orca_whirlpool';
  if (owner === RAYDIUM_AMM_V4) return 'raydium_amm_v4';
  if (owner === RAYDIUM_CLMM) return 'raydium_clmm';
  return 'unsupported';
}
export function classifyPool(pool: DiscoveredPool): PoolCapability {
  const program = identifyProgram(pool.owner);
  const ownerProgramMatchesVenue = pool.venue === 'manual'
    ? program !== 'unsupported'
    : (pool.venue === 'orca' ? program === 'orca_whirlpool' : program === 'raydium_amm_v4' || program === 'raydium_clmm');
  return {
    address:pool.address,venue:pool.venue,program,
    ownerProgramMatchesVenue,
    quoteStatus:program==='orca_whirlpool'||program==='raydium_amm_v4'||program==='raydium_clmm'?'indicative_supported':'not_implemented',
    liquidityUsd:pool.liquidityUsd
  };
}

/**
 * Build deterministic two-leg, cross-venue route candidates from confirmed
 * SOL/USDC registry results. These are topology candidates, NOT signals:
 * decoding pool state + both exact swap quote engines are required.
 */
export function buildCandidates(pools: DiscoveredPool[], maxCandidates=500): {
  capabilities:PoolCapability[]; candidates:RouteCandidate[]; rejectedPools:number;
} {
  if(!Number.isSafeInteger(maxCandidates)||maxCandidates<1)throw new Error('Invalid candidate limit');
  const byAddress = new Map(pools.map(p=>[p.address,p]));
  const unique = [...byAddress.values()].sort((a,b)=>a.address.localeCompare(b.address));
  const caps = unique.map(classifyPool);
  const eligible = unique.filter((pool,i)=>caps[i].ownerProgramMatchesVenue);
  const rejectedPools = unique.length - eligible.length;
  const candidates:RouteCandidate[] = [];
  for(const buy of eligible){
    for(const sell of eligible){
      if(buy.address===sell.address||buy.venue===sell.venue)continue;
      if(candidates.length>=maxCandidates)break;
      candidates.push({
        id:`${buy.address}:${sell.address}`,tokenPath:['USDC','SOL','USDC'],
        buyPool:buy.address,sellPool:sell.address,
        buyProgram:identifyProgram(buy.owner),sellProgram:identifyProgram(sell.owner),
        buyVenue:buy.venue,sellVenue:sell.venue,
        buyLiquidityUsd:buy.liquidityUsd,sellLiquidityUsd:sell.liquidityUsd,
        status:'requires_exact_quoters',
        reason:'Requires venue-specific on-chain state decoding, vault balances, tick-array traversal where applicable, and same-state exact amount-out quotes for both legs'
      });
    }
    if(candidates.length>=maxCandidates)break;
  }
  return {capabilities:caps,candidates,rejectedPools};
}

/**
 * Integer-only *reference* CPMM swap math for isolated fixture tests.
 * Not connected to live AMM v4 or CLMM: reserve reconciliation, dynamic
 * fee semantics, Token-2022, account snapshots and program rounding
 * must be independently verified before any adapter is marked exact.
 */
export function constantProductAmountOut(input: bigint, reserveIn: bigint, reserveOut: bigint, feeNumerator: bigint, feeDenominator: bigint): bigint {
  if(input<=0n||reserveIn<=0n||reserveOut<=0n)throw new Error('Invalid swap amount or reserves');
  if(feeDenominator<=0n||feeNumerator<0n||feeNumerator>=feeDenominator)throw new Error('Invalid fee');
  const inputAfterFee=input*(feeDenominator-feeNumerator)/feeDenominator;
  return inputAfterFee*reserveOut/(reserveIn+inputAfterFee);
}
