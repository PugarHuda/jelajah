// Transaction builders shared by the web app and the node scripts.
// Callers pass unlockers, so the same code works with a local key (scripts) or a WizardConnect placeholder (app).
import { Contract, TransactionBuilder } from 'cashscript';
import { hexToBin, binToHex, decodeTransaction, cashAddressToLockingBytecode } from '@bitauth/libauth';
import StampMinter from '../contracts/StampMinter.json' with { type: 'json' };
import StampMinter2 from '../contracts/StampMinter2.json' with { type: 'json' };
import StampMinter3 from '../contracts/StampMinter3.json' with { type: 'json' };
import RewardVault2 from '../contracts/RewardVault2.json' with { type: 'json' };
import RewardVault from '../contracts/RewardVault.json' with { type: 'json' };

export const DUST = 1000n;
const STAMP_FEE = 1500n; // ~2 sat/byte for a 3-4 input stamp tx, generous on purpose
const CLAIM_FEE = 2500n;

const hex2 = (n) => n.toString(16).padStart(2, '0');

export function rallyContracts(rally, provider) {
  // rally.minter: 3 = StampMinter3 + RewardVault2 (levy), 2 = StampMinter2 (member price), else the original StampMinter
  const vault = new Contract(rally.minter === 3 ? RewardVault2 : RewardVault,
    [rally.vmCategory, BigInt(rally.needed), BigInt(rally.reward), rally.organizerPub, BigInt(rally.endTime)], { provider });
  const vaultLock = binToHex(cashAddressToLockingBytecode(vault.address).bytecode);
  const minters = Object.fromEntries(rally.merchants.map((m) => [
    m.id, rally.minter === 3
      ? new Contract(StampMinter3, [m.lock, BigInt(m.price), BigInt(m.memberPrice), hex2(m.id), vaultLock, BigInt(rally.levy)], { provider })
      : rally.minter === 2
        ? new Contract(StampMinter2, [m.lock, BigInt(m.price), BigInt(m.memberPrice), hex2(m.id)], { provider })
        : new Contract(StampMinter, [m.lock, BigInt(m.price), hex2(m.id)], { provider }),
  ]));
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

/** Buy at one stall and receive its stamp in the same transaction. buyerLock: Uint8Array P2PKH.
 *  trophy (optional, StampMinter2 rallies): the buyer's own Trophy coin { utxo, unlocker } -> member price, trophy comes back. */
export async function buildStamp({ rally, provider, minters, merchantId, buyerLock, coins, trophy }) {
  const merchant = rally.merchants.find((m) => m.id === merchantId);
  const minter = minters[merchantId];
  // a stall may have several minter coins ("lanes"); pick one at random so simultaneous buyers rarely collide.
  // Only coins carrying the rally's minting NFT are minters; anything else sent to the address is ignored.
  const lanes = (await minter.getUtxos()).filter((u) => isMintingCoin(rally, u));
  const minterUtxo = lanes[Math.floor(Math.random() * lanes.length)];
  if (!minterUtxo) throw new Error('This stall is not open (minter not found)');
  const member = !!trophy && rally.minter >= 2;
  const price = BigInt(member ? merchant.memberPrice : merchant.price);
  const levy = rally.minter === 3 ? BigInt(rally.levy) : 0n;
  const { picked, sum } = pickCoins(coins, price + levy + DUST + STAMP_FEE + DUST);
  const tb = new TransactionBuilder({ provider }).addInput(minterUtxo, minter.unlock.stamp());
  if (member) tb.addInput(trophy.utxo, trophy.unlocker);
  picked.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  tb.addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchant.lock), amount: price })
    .addOutput({ to: buyerLock, amount: DUST, token: stampToken(rally, merchantId, buyerLock) });
  if (levy) tb.addOutput({ to: rallyVaultAddress(rally, provider), amount: levy });
  if (member) tb.addOutput({ to: buyerLock, amount: trophy.utxo.satoshis, token: trophy.utxo.token });
  return {
    inputs: member ? [trophy, ...picked] : picked,
    builder: tb.addOutput({ to: buyerLock, amount: sum - price - levy - DUST - STAMP_FEE }),
  };
}

/** Burn `needed` stamps from distinct stalls for the reward + a Trophy NFT.
 *  stamps, coins: [{ utxo, unlocker }] — coins top up the fee when the stamps' dust is not enough.
 *  @param {{ rally: any, provider: any, vault: any, buyerLock: Uint8Array, stamps: any[], coins?: any[], vaultUtxo?: any }} args */
export async function buildClaim({ rally, provider, vault, buyerLock, stamps, coins = [], vaultUtxo = undefined }) {
  vaultUtxo ??= (await vault.getUtxos()).find((u) => isMintingCoin(rally, u)); // levy coins (and junk) share the vault's address
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

const MERGE_FEE = 500n; // per input; RewardVault2.merge allows up to 600, and never out of the vault coin itself
const MAX_MERGE = 30;

/** Levy rallies: fold the levy coins at the vault address into the vault coin. Needs no signature, anyone can send it.
 *  Returns the new vault coin, or null when there is nothing worth merging. */
export async function mergeLevies({ rally, provider, vault }) {
  if (rally.minter !== 3) return null;
  const all = await vault.getUtxos();
  const vaultCoin = all.find((u) => isMintingCoin(rally, u));
  // largest first, capped so one merge stays well under the standard tx size; the rest wait for the next merge
  const levies = all.filter((u) => !u.token && u.satoshis > MERGE_FEE * 2n)
    .sort((a, b) => Number(b.satoshis - a.satoshis)).slice(0, MAX_MERGE);
  if (!vaultCoin || !levies.length) return null;
  const ins = [vaultCoin, ...levies];
  const amount = ins.reduce((s, u) => s + u.satoshis, 0n) - MERGE_FEE * BigInt(ins.length);
  const tb = new TransactionBuilder({ provider });
  ins.forEach((u) => tb.addInput(u, vault.unlock.merge()));
  const { txid } = await tb.addOutput({ to: vault.tokenAddress, amount, token: vaultCoin.token }).send();
  return { ...vaultCoin, txid, vout: 0, satoshis: amount };
}

const rallyVaultAddress = (rally, provider) => rallyContracts(rally, provider).vault.address;

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
  const ofRally = (o) => o?.token && binToHex(o.token.category) === rally.category;
  const lockOf = (c) => binToHex(cashAddressToLockingBytecode(c.address).bytecode);
  // A real spend of a covenant hands the rally's minting NFT back to that covenant at out[0]. Only the
  // covenant holds that NFT, so junk sent to its address (or a fake NFT of another category) never counts.
  const spends = (c) => ({ tx }) => ofRally(tx.outputs[0]) && tx.outputs[0].token.nft?.capability === 'minting'
    && binToHex(tx.outputs[0].lockingBytecode) === lockOf(c);
  const stalls = await Promise.all(rally.merchants.map(async (m) => {
    const sales = (await txsOf(minters[m.id])).filter(spends(minters[m.id]))
      .filter(({ tx }) => ofRally(tx.outputs[2]) && tx.outputs[2].token.nft?.commitment[0] === m.id);
    const buyers = new Set(sales.map(({ tx }) => binToHex(tx.outputs[2].token.nft.commitment.slice(1))));
    const revenue = sales.reduce((s, { tx }) => s + tx.outputs[1].valueSatoshis, 0n);
    return { id: m.id, stamps: sales.length, buyers: buyers.size, revenue };
  }));
  // claims mint a trophy (commitment 0x00 + pkh) at out[2]; reclaim does not
  const claims = (await txsOf(vault)).filter(spends(vault))
    .filter(({ tx }) => ofRally(tx.outputs[2]) && tx.outputs[2].token.nft?.commitment[0] === 0).length;
  return { stalls, claims };
}

/** The coin that holds this rally's minting NFT (a minter lane or the vault), not junk sent to the same address. */
export const isMintingCoin = (rally, u) => u.token?.category === rally.category && u.token.nft?.capability === 'minting';

export const isRallyNft = (rally, utxo) => utxo.token?.category === rally.category && utxo.token.nft;
const pkhOf = (lock) => Array.from(lock.slice(3, 23), (b) => b.toString(16).padStart(2, '0')).join('');
const nft = (rally, commitment) => ({ category: rally.category, amount: 0n, nft: { capability: 'none', commitment } });
const stampToken = (rally, id, buyerLock) => nft(rally, hex2(id) + pkhOf(buyerLock));
