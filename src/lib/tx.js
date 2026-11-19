// Transaction builders shared by the web app and the node scripts.
// Callers pass unlockers, so the same code works with a local key (scripts) or a WizardConnect placeholder (app).
import { Contract, TransactionBuilder } from 'cashscript';
import { hexToBin, binToHex, decodeTransaction } from '@bitauth/libauth';
import StampMinter from '../contracts/StampMinter.json' with { type: 'json' };
import RewardVault from '../contracts/RewardVault.json' with { type: 'json' };

export const DUST = 1000n;
const STAMP_FEE = 1500n; // ~2 sat/byte for a 3-4 input stamp tx, generous on purpose
const CLAIM_FEE = 2500n;

const hex2 = (n) => n.toString(16).padStart(2, '0');

export function rallyContracts(rally, provider) {
  const minters = Object.fromEntries(rally.merchants.map((m) => [
    m.id, new Contract(StampMinter, [m.lock, BigInt(m.price), hex2(m.id)], { provider }),
  ]));
  const vault = new Contract(RewardVault, [rally.vmCategory, BigInt(rally.needed), BigInt(rally.reward), rally.organizerPub, BigInt(rally.endTime)], { provider });
  return { minters, vault };
}

/** Pick BCH-only coins until `target` is covered. coins: [{ utxo, unlocker }] */
export function pickCoins(coins, target) {
  const picked = [];
  let sum = 0n;
  for (const c of [...coins].filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))) {
    if (sum >= target) break;
    picked.push(c);
    sum += c.utxo.satoshis;
  }
  if (sum < target) throw new Error(`Not enough BCH: need ${target} sats, wallet has ${sum} spendable`);
  return { picked, sum };
}

/** Buy at one stall and receive its stamp in the same transaction. buyerLock: Uint8Array P2PKH */
export async function buildStamp({ rally, provider, minters, merchantId, buyerLock, coins }) {
  const merchant = rally.merchants.find((m) => m.id === merchantId);
  const minter = minters[merchantId];
  const [minterUtxo] = await minter.getUtxos();
  if (!minterUtxo) throw new Error('This stall is not open (minter not found)');
  const price = BigInt(merchant.price);
  const { picked, sum } = pickCoins(coins, price + DUST + STAMP_FEE + DUST);
  const tb = new TransactionBuilder({ provider }).addInput(minterUtxo, minter.unlock.stamp());
  picked.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  return {
    inputs: picked,
    builder: tb
      .addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis, token: minterUtxo.token })
      .addOutput({ to: hexToBin(merchant.lock), amount: price })
      .addOutput({ to: buyerLock, amount: DUST, token: stampToken(rally, merchantId, buyerLock) })
      .addOutput({ to: buyerLock, amount: sum - price - DUST - STAMP_FEE }),
  };
}

/** Burn `needed` stamps from distinct stalls for the reward + a Trophy NFT.
 *  stamps, coins: [{ utxo, unlocker }] — coins top up the fee when the stamps' dust is not enough.
 *  @param {{ rally: any, provider: any, vault: any, buyerLock: Uint8Array, stamps: any[], coins?: any[] }} args */
export async function buildClaim({ rally, provider, vault, buyerLock, stamps, coins = [] }) {
  const [vaultUtxo] = await vault.getUtxos();
  if (!vaultUtxo) throw new Error('This rally is over (vault not found)');
  const reward = BigInt(rally.reward);
  if (vaultUtxo.satoshis - reward < DUST) throw new Error('The reward pool is empty');
  const set = pickSet(rally, stamps);
  const stampDust = set.reduce((s, x) => s + x.utxo.satoshis, 0n);
  const shortfall = DUST + CLAIM_FEE - stampDust; // the trophy and the fee come out of the stamps' dust first
  const { picked, sum } = shortfall > 0n ? pickCoins(coins, shortfall) : { picked: [], sum: 0n };
  const tb = new TransactionBuilder({ provider }).addInput(vaultUtxo, vault.unlock.claim());
  [...set, ...picked].forEach((s) => tb.addInput(s.utxo, s.unlocker));
  const back = stampDust + sum - DUST - CLAIM_FEE;
  return {
    inputs: [...set, ...picked],
    builder: tb
      .addOutput({ to: vault.tokenAddress, amount: vaultUtxo.satoshis - reward, token: vaultUtxo.token })
      .addOutput({ to: buyerLock, amount: reward + back })
      .addOutput({ to: buyerLock, amount: DUST, token: nft(rally, '00' + pkhOf(buyerLock)) }),
  };
}

/** One stamp per stall, lowest stall ids first, ordered as the vault requires. */
export function pickSet(rally, stamps) {
  const byStall = new Map();
  for (const s of stamps) {
    const id = parseInt(s.utxo.token.nft.commitment.slice(0, 2), 16);
    if (id > 0 && !byStall.has(id)) byStall.set(id, s);
  }
  const set = [...byStall.entries()].sort((a, b) => a[0] - b[0]).slice(0, rally.needed).map(([, s]) => s);
  if (set.length < rally.needed) throw new Error(`Collect stamps from ${rally.needed} different stalls first (${set.length} so far)`);
  return set;
}

/** Per-stall sales and claims, read from the chain: every spend of a minter is one paid stamp.
 *  ponytail: one Electrum round trip per tx, fine for hundreds of stamps; index by height if a rally gets big. */
export async function rallyStats({ rally, provider, minters, vault }) {
  const txsOf = async (contract) => {
    const hist = await provider.performRequest('blockchain.address.get_history', contract.address);
    const ids = hist.map((h) => h.tx_hash).filter((id) => id !== rally.genesisTx);
    return Promise.all(ids.map(async (id) => {
      const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(id)));
      if (typeof tx === 'string') throw new Error(tx);
      return { id, tx };
    }));
  };
  const stalls = await Promise.all(rally.merchants.map(async (m) => {
    // only spends of the minter (input 0) are stamps; anything else sent to its address is noise
    const sales = (await txsOf(minters[m.id])).filter(({ tx }) => tx.outputs[2]?.token?.nft?.commitment.length === 21);
    const buyers = new Set(sales.map(({ tx }) => binToHex(tx.outputs[2].token.nft.commitment.slice(1))));
    const revenue = sales.reduce((s, { tx }) => s + tx.outputs[1].valueSatoshis, 0n);
    return { id: m.id, stamps: sales.length, buyers: buyers.size, revenue };
  }));
  // claims mint a trophy (commitment 0x00 + pkh) at out[2]; reclaim does not
  const claims = (await txsOf(vault)).filter(({ tx }) => tx.outputs[2]?.token?.nft?.commitment[0] === 0).length;
  return { stalls, claims };
}

export const isRallyNft =(rally, utxo) => utxo.token?.category === rally.category && utxo.token.nft;
const pkhOf = (lock) => Array.from(lock.slice(3, 23), (b) => b.toString(16).padStart(2, '0')).join('');
const nft = (rally, commitment) => ({ category: rally.category, amount: 0n, nft: { capability: 'none', commitment } });
const stampToken = (rally, id, buyerLock) => nft(rally, hex2(id) + pkhOf(buyerLock));
