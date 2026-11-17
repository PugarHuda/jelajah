// Transaction builders for pull-based Merkle claims. Shared by the tests and the CLI.
import { Contract, TransactionBuilder } from 'cashscript';
import { binToHex, hexToBin, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import ClaimPool from '../artifacts/ClaimPool.json' with { type: 'json' };
import RootKeeper from '../artifacts/RootKeeper.json' with { type: 'json' };
import RootProposal from '../artifacts/RootProposal.json' with { type: 'json' };
import { buildTrees, claimedLeaf, rootsCommitment, proposalCommitment, epochOf } from './merkle.js';

export const DUST = 1000n;
const vm = (category) => binToHex(hexToBin(category).reverse()); // introspection byte order

/** cfg: { keeperCategory, proposalCategory, rewardCategory, depth, delay, operatorPub } (categories in display order) */
export function claimContracts(cfg, provider) {
  const pool = new Contract(ClaimPool, [vm(cfg.keeperCategory), vm(cfg.rewardCategory), BigInt(cfg.depth)], { provider });
  const proposal = new Contract(RootProposal, [BigInt(cfg.delay), cfg.operatorPub, vm(cfg.keeperCategory)], { provider });
  const keeper = new Contract(RootKeeper, [pool.lockingBytecode, proposal.lockingBytecode, vm(cfg.proposalCategory)], { provider });
  return { pool, keeper, proposal };
}

/**
 * Claim everything a folder has earned but not yet claimed.
 * dist: { depth, entries: [{ index, pkh, cumulative }] }, claimed: { [index]: amount already claimed }
 * coins: [{ utxo, unlocker }] BCH-only, they pay the dust + fee
 */
export async function buildClaim({ pool, keeper, dist, claimed, pkh, coins, fee = 3000n }) {
  const entry = dist.entries.find((e) => e.pkh === pkh);
  if (!entry) throw new Error('this address has no entry in the distribution');
  const before = BigInt(claimed[entry.index] ?? 0);
  const cumulative = BigInt(entry.cumulative);
  if (cumulative <= before) throw new Error('nothing to claim');
  const trees = buildTrees(dist.depth, dist.entries, claimed);
  const after = buildTrees(dist.depth, [], { ...claimed, [entry.index]: cumulative }).claimed;

  const [poolUtxo] = await pool.getUtxos();
  const [keeperUtxo] = await keeper.getUtxos();
  if (!poolUtxo || !keeperUtxo) throw new Error('pool or keeper not found');
  const epoch = epochOf(keeperUtxo.token.nft.commitment);
  const want = rootsCommitment(trees.earned.root(), trees.claimed.root(), epoch);
  if (keeperUtxo.token.nft.commitment !== want) throw new Error('local trees do not match the on-chain roots (sync first)');

  const payout = cumulative - before;
  const picked = [];
  let sum = 0n;
  for (const c of coins.filter((c) => !c.utxo.token)) { if (sum >= DUST + fee) break; picked.push(c); sum += c.utxo.satoshis; }
  if (sum < DUST + fee) throw new Error(`need ${DUST + fee} sats for dust + fee`);

  const owner = encodeLockingBytecodeP2pkh(hexToBin(pkh));
  const tb = new TransactionBuilder({ provider: pool.provider })
    .addInput(poolUtxo, pool.unlock.claim(pkh, cumulative, before, BigInt(entry.index), trees.earned.proof(entry.index), trees.claimed.proof(entry.index)))
    .addInput(keeperUtxo, keeper.unlock.claim());
  picked.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  tb.addOutput({ to: pool.tokenAddress, amount: poolUtxo.satoshis, token: { ...poolUtxo.token, amount: poolUtxo.token.amount - payout } })
    .addOutput({ to: keeper.tokenAddress, amount: keeperUtxo.satoshis, token: { ...keeperUtxo.token, nft: { ...keeperUtxo.token.nft, commitment: rootsCommitment(trees.earned.root(), after.root(), epoch) } } })
    .addOutput({ to: owner, amount: DUST, token: { category: poolUtxo.token.category, amount: payout } });
  const change = sum - DUST - fee;
  if (change >= DUST) tb.addOutput({ to: owner, amount: change });
  return { builder: tb, payout, index: entry.index, inputs: picked, newClaimedLeaf: claimedLeaf(cumulative) };
}

/** Operator: mint a proposal NFT (proposal category) holding a new earned root for a newer epoch. authority: { utxo, unlocker } minting NFT */
export function buildPropose({ proposal, authority, root, epoch, coins, changeLock, fee = 1500n }) {
  const tb = new TransactionBuilder({ provider: proposal.provider }).addInput(authority.utxo, authority.unlocker);
  coins.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  const sum = coins.reduce((s, c) => s + c.utxo.satoshis, authority.utxo.satoshis);
  return tb
    .addOutput({ to: changeLock, amount: authority.utxo.satoshis, token: authority.utxo.token })
    .addOutput({ to: proposal.tokenAddress, amount: DUST, token: { category: authority.utxo.token.category, amount: 0n, nft: { capability: 'none', commitment: proposalCommitment(root, epoch) } } })
    .addOutput({ to: changeLock, amount: sum - authority.utxo.satoshis - DUST - fee });
}

/** Anyone: promote a matured proposal into the keeper. coin pays the fee. */
export async function buildActivate({ keeper, proposal, delay, coin, changeLock, fee = 1500n }) {
  const [keeperUtxo] = await keeper.getUtxos();
  const [prop] = await proposal.getUtxos();
  if (!prop) throw new Error('no proposal waiting');
  const claimedRoot = keeperUtxo.token.nft.commitment.slice(64, 128);
  return new TransactionBuilder({ provider: keeper.provider })
    .addInput(keeperUtxo, keeper.unlock.activate())
    .addInput(prop, proposal.unlock.activate(), { sequence: Number(delay) })
    .addInput(coin.utxo, coin.unlocker)
    .addOutput({ to: keeper.tokenAddress, amount: keeperUtxo.satoshis, token: { ...keeperUtxo.token, nft: { ...keeperUtxo.token.nft, commitment: prop.token.nft.commitment.slice(0, 64) + claimedRoot + prop.token.nft.commitment.slice(64) } } })
    .addOutput({ to: changeLock, amount: coin.utxo.satoshis + prop.satoshis - fee });
}
