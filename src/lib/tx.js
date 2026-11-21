// Transaction builders shared by the web app and the node scripts.
// Callers pass unlockers, so the same code works with a local key (scripts) or a WizardConnect placeholder (app).
import { Contract, TransactionBuilder } from 'cashscript';
import { hexToBin, binToHex, decodeTransaction, cashAddressToLockingBytecode, secp256k1, sha256 } from '@bitauth/libauth';
import StampMinter from '../contracts/StampMinter.json' with { type: 'json' };
import StampMinter2 from '../contracts/StampMinter2.json' with { type: 'json' };
import StampMinter3 from '../contracts/StampMinter3.json' with { type: 'json' };
import RewardVault2 from '../contracts/RewardVault2.json' with { type: 'json' };
import SponsorPool from '../contracts/SponsorPool.json' with { type: 'json' };
import PassportVault from '../contracts/PassportVault.json' with { type: 'json' };
import RewardVault from '../contracts/RewardVault.json' with { type: 'json' };

export const DUST = 1000n;
const STAMP_FEE = 1500n; // ~2 sat/byte for a 3-4 input stamp tx, generous on purpose
const CLAIM_FEE = 2500n;

const hex2 = (n) => n.toString(16).padStart(2, '0');

export function rallyContracts(rally, provider) {
  // rally.minter: 3 = StampMinter3 + RewardVault2 (levy), 2 = StampMinter2 (member price), else the original StampMinter
  const vault = rally.minter === 3
    ? new Contract(RewardVault2, [rally.vmCategory, BigInt(rally.needed), BigInt(rally.reward),
      BigInt(rally.bonusNeeded ?? 0), BigInt(rally.bonusReward ?? 0), BigInt(rally.levy), rally.organizerPub, BigInt(rally.endTime)], { provider })
    : new Contract(RewardVault, [rally.vmCategory, BigInt(rally.needed), BigInt(rally.reward), rally.organizerPub, BigInt(rally.endTime)], { provider });
  const vaultLock = binToHex(cashAddressToLockingBytecode(vault.address).bytecode);
  const minters = Object.fromEntries(rally.merchants.map((m) => [
    m.id, rally.minter === 3
      ? new Contract(StampMinter3, [m.lock, BigInt(m.price), BigInt(m.memberPrice), hex2(m.id), vaultLock, BigInt(rally.levy), m.presenceKey ?? ''], { provider })
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
/** The rally's sponsor pool (subsidy coins), when a sponsor backs it: rally.sponsor = { vmCategory of the voucher, value, sponsorPub, endTime } */
export const sponsorPool = (rally, provider) => rally.sponsor && new Contract(SponsorPool,
  [rally.vmCategory, rally.sponsor.vmCategory, BigInt(rally.sponsor.value), rally.sponsor.sponsorPub, BigInt(rally.sponsor.endTime)], { provider });
/** A voucher the buyer can spend: exactly 1 fungible token of the sponsor's category (SponsorPool burns exactly one). */
export const isVoucher = (rally, u) => !!rally.sponsor && u.token?.category === rally.sponsor.category && u.token.amount === 1n && !u.token.nft;

/** Buy at one stall. Returns the wallet's inputs with their input index (contract inputs sit between them).
 *  @param {{ rally: any, provider: any, minters: any, merchantId: number, buyerLock: Uint8Array, coins: any[], trophy?: any, presence?: Uint8Array, lane?: any, voucher?: any }} args */
export async function buildStamp({ rally, provider, minters, merchantId, buyerLock, coins, trophy, presence, lane, voucher }) {
  const merchant = rally.merchants.find((m) => m.id === merchantId);
  const minter = minters[merchantId];
  // a stall may have several minter coins ("lanes"); pick one at random so simultaneous buyers rarely collide.
  // Only coins carrying the rally's minting NFT are minters; anything else sent to the address is ignored.
  // a presence signature is bound to one lane coin, so then the caller passes that lane
  const minterUtxo = lane ?? await pickLane(rally, minter);
  if (!minterUtxo) throw new Error('This stall is not open (minter not found)');
  const member = !!trophy && rally.minter >= 2;
  const price = BigInt(member ? merchant.memberPrice : merchant.price);
  const levy = rally.minter === 3 ? BigInt(rally.levy) : 0n;
  // sponsored: a subsidy coin + one voucher pay `sponsor.value` of the price (levy rallies only; SponsorPool checks it)
  const pool = voucher && rally.minter === 3 ? sponsorPool(rally, provider) : null;
  const subsidy = pool ? (await pool.getUtxos()).find((u) => !u.token && u.satoshis === BigInt(rally.sponsor.value)) : null;
  if (voucher && !subsidy) throw new Error('The sponsor has no subsidy left');
  const off = subsidy ? subsidy.satoshis : 0n;
  const { picked, sum } = pickCoins(coins, price + levy - off + DUST + STAMP_FEE + DUST);
  // levy rallies take the stall's presence signature (ignored by stalls without a presenceKey)
  const unlock = rally.minter === 3 ? minter.unlock.stamp(presence ?? new Uint8Array(64)) : minter.unlock.stamp();
  const tb = new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: !!subsidy }).addInput(minterUtxo, unlock);
  const wallet = []; // [coin, input index]
  if (member) { wallet.push([trophy, 1]); tb.addInput(trophy.utxo, trophy.unlocker); }
  if (subsidy) { // order matters: subsidy at in[1] or in[2], its voucher right after it
    tb.addInput(subsidy, pool.unlock.redeem());
    wallet.push([voucher, member ? 3 : 2]); tb.addInput(voucher.utxo, voucher.unlocker);
  }
  picked.forEach((c) => { wallet.push([c, wallet.length + 1 + (subsidy ? 1 : 0)]); tb.addInput(c.utxo, c.unlocker); });
  tb.addOutput({ to: minter.tokenAddress, amount: minterUtxo.satoshis, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchant.lock), amount: price })
    .addOutput({ to: buyerLock, amount: DUST, token: stampToken(rally, merchantId, buyerLock) });
  if (levy) tb.addOutput({ to: rallyVaultAddress(rally, provider), amount: levy });
  if (member) tb.addOutput({ to: buyerLock, amount: trophy.utxo.satoshis, token: trophy.utxo.token });
  const voucherDust = subsidy ? voucher.utxo.satoshis : 0n;
  return {
    inputs: wallet.map(([c, index]) => ({ ...c, index })),
    builder: tb.addOutput({ to: buyerLock, amount: sum + off + voucherDust - price - levy - DUST - STAMP_FEE }),
  };
}

/** Burn `needed` stamps from distinct stalls for the reward + a Trophy NFT.
 *  stamps, coins: [{ utxo, unlocker }] — coins top up the fee when the stamps' dust is not enough.
 *  @param {{ rally: any, provider: any, vault: any, buyerLock: Uint8Array, stamps: any[], coins?: any[], vaultUtxo?: any, bonus?: boolean }} args */
export async function buildClaim({ rally, provider, vault, buyerLock, stamps, coins = [], vaultUtxo = undefined, bonus = false }) {
  vaultUtxo ??= (await vault.getUtxos()).find((u) => isMintingCoin(rally, u)); // levy coins (and junk) share the vault's address
  if (!vaultUtxo) throw new Error('This rally is over (vault not found)');
  // bonus tier (RewardVault2): burn bonusNeeded different stalls for bonusReward
  const tier = bonus && rally.bonusNeeded ? rally.bonusNeeded : rally.needed;
  const reward = BigInt(tier === rally.needed ? rally.reward : rally.bonusReward);
  if (vaultUtxo.satoshis - reward < DUST) throw new Error('The reward pool is too low for this claim');
  const set = pickSet(rally, stamps, tier);
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
      // a bonus claim mints the bonus trophy 00 ‖ pkh ‖ 02 (RewardVault2 checks the tier)
      .addOutput({ to: buyerLock, amount: DUST, token: nft(rally, '00' + pkhOf(buyerLock) + (tier === rally.needed ? '' : '02')) }),
  };
}

const MERGE_FEE = 950n; // per input (each reveals the ~740-byte vault script); RewardVault2.merge allows up to 1000, never out of the vault coin
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
export function pickSet(rally, stamps, n = rally.needed) {
  const byStall = new Map();
  for (const s of stamps) {
    const id = parseInt(s.utxo.token.nft.commitment.slice(0, 2), 16);
    if (id > 0 && !byStall.has(id)) byStall.set(id, s);
  }
  const set = [...byStall.entries()].sort((a, b) => a[0] - b[0]).slice(0, n).map(([, s]) => s);
  if (set.length < n) throw new Error(`Collect stamps from ${n} different stalls first (${set.length} so far)`);
  return set;
}

/** Per-stall sales and claims, read from the chain: every spend of a minter is one paid stamp.
 *  ponytail: one Electrum round trip per tx, fine for hundreds of stamps; index by height if a rally gets big. */
// Transactions at a covenant's address (unconfirmed ones too), minus the genesis and any txids in `skip`.
async function txsOf(rally, provider, contract, skip) {
  const hist = await provider.performRequest('blockchain.address.get_history', contract.address);
  const ids = hist.map((h) => h.tx_hash).filter((id) => id !== rally.genesisTx && !skip?.has(id));
  return Promise.all(ids.map(async (id) => {
    const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(id)));
    if (typeof tx === 'string') throw new Error(tx);
    return { id, tx };
  }));
}
const ofRally = (rally, o) => o?.token && binToHex(o.token.category) === rally.category;
// A real spend of a covenant hands the rally's minting NFT back to that covenant at out[0]. Only the
// covenant holds that NFT, so junk sent to its address (or a fake NFT of another category) never counts.
const spends = (rally, c) => ({ tx }) => ofRally(rally, tx.outputs[0]) && tx.outputs[0].token.nft?.capability === 'minting'
  && binToHex(tx.outputs[0].lockingBytecode) === binToHex(cashAddressToLockingBytecode(c.address).bytecode);

/** Every real sale at one stall: { ids: all txids looked at, sales: [{ id, buyerPkh, paid }] }. Pass the previous
 *  `ids` as `skip` to poll cheaply (the stall's till page). */
export async function stallSales({ rally, provider, minter, merchantId, skip }) {
  const txs = await txsOf(rally, provider, minter, skip);
  const sales = txs.filter(spends(rally, minter))
    .filter(({ tx }) => ofRally(rally, tx.outputs[2]) && tx.outputs[2].token.nft?.commitment[0] === merchantId)
    .map(({ id, tx }) => ({ id, buyerPkh: binToHex(tx.outputs[2].token.nft.commitment.slice(1)), paid: tx.outputs[1].valueSatoshis }));
  return { ids: txs.map((t) => t.id), sales };
}

export async function rallyStats({ rally, provider, minters, vault }) {
  // collectors: pkh -> stalls visited, stamps bought, trophies won (every stamp and trophy commits to its owner's pkh)
  const people = new Map();
  const who = (pkh) => people.get(pkh) ?? people.set(pkh, { pkh, stalls: new Set(), stamps: 0, trophies: 0 }).get(pkh);
  const stalls = await Promise.all(rally.merchants.map(async (m) => {
    const { sales } = await stallSales({ rally, provider, minter: minters[m.id], merchantId: m.id });
    sales.forEach((s) => { const p = who(s.buyerPkh); p.stamps++; p.stalls.add(m.id); });
    const revenue = sales.reduce((s, x) => s + x.paid, 0n);
    return { id: m.id, stamps: sales.length, buyers: new Set(sales.map((s) => s.buyerPkh)).size, revenue };
  }));
  // claims mint a trophy (commitment 0x00 + pkh) at out[2]; reclaim does not
  const claimTxs = (await txsOf(rally, provider, vault)).filter(spends(rally, vault))
    .filter(({ tx }) => ofRally(rally, tx.outputs[2]) && tx.outputs[2].token.nft?.commitment[0] === 0);
  claimTxs.forEach(({ tx }) => who(binToHex(tx.outputs[2].token.nft.commitment.slice(1, 21))).trophies++); // bonus trophies carry a tier byte
  const collectors = [...people.values()].map((p) => ({ ...p, stalls: p.stalls.size }))
    .sort((a, b) => b.trophies - a.trophies || b.stalls - a.stalls || b.stamps - a.stamps).slice(0, 10);
  return { stalls, claims: claimTxs.length, collectors };
}

/** After endTime the organizer takes back the pool: the vault coin (and its minting NFT, retiring the rally) plus any
 *  unmerged levy coins. signer: a cashscript SignatureTemplate of the organizer key; to: locking bytecode or address.
 *  Nodes compare a time locktime with the median time past, which runs about an hour behind the clock. */
export async function buildReclaim({ rally, provider, vault, signer, to }) {
  const coins = await vault.getUtxos();
  const vaultCoin = coins.find((u) => isMintingCoin(rally, u));
  if (!vaultCoin) throw new Error('Nothing to reclaim: the vault is already empty');
  const total = coins.reduce((s, u) => s + u.satoshis, 0n);
  const tb = new TransactionBuilder({ provider });
  coins.forEach((u) => tb.addInput(u, vault.unlock.reclaim(signer)));
  return { builder: tb.addOutput({ to, amount: total - 1000n * BigInt(coins.length), token: vaultCoin.token }).setLocktime(rally.endTime), total };
}

/** One of the stall's minter coins, at random, so simultaneous buyers rarely collide. */
export async function pickLane(rally, minter) {
  const lanes = (await minter.getUtxos()).filter((u) => isMintingCoin(rally, u));
  return lanes[Math.floor(Math.random() * lanes.length)];
}

// ---- proof of presence: the stall's device signs rallyCategory ‖ merchantId ‖ buyer pkh ‖ minter outpoint
// (what StampMinter3 checks). The outpoint is the lane coin the stamp will spend, so every code is single use.
const le32 = (n) => [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
export const presenceMessage = (rally, merchantId, buyerPkhHex, outpoint) => hexToBin(rally.vmCategory + hex2(merchantId) + buyerPkhHex
  + binToHex(hexToBin(outpoint.txid).reverse()) + le32(outpoint.vout));
/** The buyer's code for the stall's device: pkh:txid:vout of the lane coin they will spend. */
export const presenceCode = (buyerPkhHex, lane) => `${buyerPkhHex}:${lane.txid}:${lane.vout}`;
export function parsePresenceCode(code) {
  const m = /^([0-9a-f]{40}):([0-9a-f]{64}):(\d{1,5})$/.exec(code.trim().toLowerCase());
  return m ? { buyerPkh: m[1], outpoint: { txid: m[2], vout: Number(m[3]) } } : null;
}
/** Schnorr datasig as OP_CHECKDATASIG expects it (over sha256 of the message). */
export function signPresence(privateKey, rally, merchantId, buyerPkhHex, outpoint) {
  const sig = secp256k1.signMessageHashSchnorr(privateKey, sha256.hash(presenceMessage(rally, merchantId, buyerPkhHex, outpoint)));
  if (typeof sig === 'string') throw new Error(sig);
  return sig;
}

/** The coin that holds this rally's minting NFT (a minter lane or the vault), not junk sent to the same address. */
export const isMintingCoin = (rally, u) => u.token?.category === rally.category && u.token.nft?.capability === 'minting';

export const isRallyNft = (rally, utxo) => utxo.token?.category === rally.category && utxo.token.nft;
const pkhOf = (lock) => Array.from(lock.slice(3, 23), (b) => b.toString(16).padStart(2, '0')).join('');
const nft = (rally, commitment) => ({ category: rally.category, amount: 0n, nft: { capability: 'none', commitment } });
const stampToken = (rally, id, buyerLock) => nft(rally, hex2(id) + pkhOf(buyerLock));

// ---- opening a rally: shared by scripts/rally.mjs (local key) and the organizer page (WizardConnect)

/** Rule checks on a rally config ({ needed, reward, rewardsInPool, lanes?, levy?, merchants: [{ id, price, memberPrice? }] }). */
export function checkRallyConfig(cfg) {
  if (!(cfg.needed >= 1 && cfg.needed <= cfg.merchants.length)) throw new Error(`needed must be 1..${cfg.merchants.length}`);
  if (cfg.merchants.some((m) => !(m.id >= 1 && m.id <= 127))) throw new Error('merchant ids must be 1..127');
  if (new Set(cfg.merchants.map((m) => m.id)).size !== cfg.merchants.length) throw new Error('merchant ids must be unique');
  if (cfg.merchants.some((m) => !(m.price >= 546))) throw new Error('every price must be at least 546 sats');
  if (cfg.merchants.some((m) => (m.memberPrice ?? m.price) > m.price)) throw new Error('memberPrice must be <= price');
  // a trophy holder pays memberPrice, so that is the cheapest way to a full set
  const cheapest = cfg.merchants.map((m) => m.memberPrice ?? m.price).sort((a, b) => a - b).slice(0, cfg.needed).reduce((a, b) => a + b, 0);
  if (!(cfg.reward < cheapest)) throw new Error(`anti-farming: reward ${cfg.reward} must be < cheapest set ${cheapest}`);
  if (!(cfg.rewardsInPool >= 1)) throw new Error('fund at least one reward');
  if (cfg.merchants.some((m) => m.presenceKey !== undefined && !/^0[23][0-9a-f]{64}$/.test(m.presenceKey))) throw new Error('a presence key is a 33-byte compressed public key (66 hex)');
  if (cfg.merchants.some((m) => m.presenceKey) && cfg.levy === undefined) throw new Error('proof of presence needs a levy rally');
  // levy rallies: each set must fund its own reward, or colluding stalls can drain the pool.
  // A merge costs up to 1000 sats per coin, so count that against the levies of one set (plus the vault coin's merge).
  if (cfg.levy !== undefined && cfg.needed * (cfg.levy - 1000) - 1000 < cfg.reward)
    throw new Error(`anti-collusion: ${cfg.needed} levies of ${cfg.levy} (minus merge fees) must cover the reward ${cfg.reward}`);
  // bonus tier: more stalls, bigger reward; same anti-farming and anti-collusion rules at that size
  if (cfg.bonusNeeded !== undefined) {
    if (cfg.levy === undefined) throw new Error('a bonus tier needs a levy rally');
    if (!(cfg.bonusNeeded > cfg.needed && cfg.bonusNeeded <= cfg.merchants.length)) throw new Error(`bonus stalls must be ${cfg.needed + 1}..${cfg.merchants.length}`);
    if (!(cfg.bonusReward > cfg.reward)) throw new Error('the bonus reward must be bigger than the reward');
    const cheapestBonus = cfg.merchants.map((m) => m.memberPrice ?? m.price).sort((a, b) => a - b).slice(0, cfg.bonusNeeded).reduce((a, b) => a + b, 0);
    if (!(cfg.bonusReward < cheapestBonus)) throw new Error(`anti-farming: bonus ${cfg.bonusReward} must be < cheapest bonus set ${cheapestBonus}`);
    if (cfg.bonusNeeded * (cfg.levy - 1000) - 1000 < cfg.bonusReward)
      throw new Error(`anti-collusion: ${cfg.bonusNeeded} levies of ${cfg.levy} (minus merge fees) must cover the bonus ${cfg.bonusReward}`);
  }
}

/** Sats the genesis needs: the pool (+ dust the vault keeps after its last claim), a coin per minter lane, identity, fees. */
export const genesisNeed = (cfg) => BigInt(cfg.reward) * BigInt(cfg.rewardsInPool) + DUST
  + DUST * BigInt(cfg.merchants.length * (cfg.lanes ?? 1) + 2) + 5_000n;

/** The rally record. category = txid of the vout-0 coin the genesis spends; merchants need their payout `lock` (hex). */
export function planRally({ network, cfg, organizerPub, baseTxid }) {
  checkRallyConfig(cfg);
  return {
    network, name: cfg.name, description: cfg.description ?? '', category: baseTxid,
    vmCategory: binToHex(hexToBin(baseTxid).reverse()), // the VM sees the category in internal byte order
    needed: cfg.needed, reward: cfg.reward, endTime: Math.floor(Date.now() / 1000) + cfg.durationDays * 86400,
    organizerPub, lanes: cfg.lanes ?? 1,
    ...(cfg.levy !== undefined ? { minter: 3, levy: cfg.levy } : { minter: 2 }),
    ...(cfg.bonusNeeded !== undefined ? { bonusNeeded: cfg.bonusNeeded, bonusReward: cfg.bonusReward } : {}),
    merchants: cfg.merchants.map((m) => ({ ...m, memberPrice: m.memberPrice ?? m.price })),
  };
}

/** Genesis: out[0] identity (back to the organizer), `lanes` minting NFTs per stall minter, the vault with the pool,
 *  optional BCMR OP_RETURN, change. base: { utxo (vout 0), unlocker }.
 *  @param {{ provider: any, rally: any, rewardsInPool: number, base: any, organizerLock: Uint8Array, bcmr?: { hash: string, uri: string } }} args */
export function buildGenesis({ provider, rally, rewardsInPool, base, organizerLock, bcmr }) {
  if (base.utxo.vout !== 0 || base.utxo.txid !== rally.category) throw new Error('genesis must spend the vout-0 coin named by the category');
  const { minters, vault } = rallyContracts(rally, provider);
  const pool = BigInt(rally.reward) * BigInt(rewardsInPool) + DUST;
  const minting = { category: rally.category, amount: 0n, nft: { capability: 'minting', commitment: '' } };
  const tb = new TransactionBuilder({ provider }).addInput(base.utxo, base.unlocker).addOutput({ to: organizerLock, amount: DUST });
  Object.values(minters).forEach((c) => { for (let l = 0; l < rally.lanes; l++) tb.addOutput({ to: c.tokenAddress, amount: DUST, token: minting }); });
  tb.addOutput({ to: vault.tokenAddress, amount: pool, token: minting });
  if (bcmr) tb.addOpReturnOutput(['BCMR', `0x${bcmr.hash}`, bcmr.uri]);
  const spent = DUST * BigInt(Object.keys(minters).length * rally.lanes + 1) + pool;
  return { builder: tb.addOutput({ to: organizerLock, amount: base.utxo.satoshis - spent - 3000n }), vault };
}

// ---- passport across two rallies (PassportVault): trade a trophy from each for a reward + a Passport NFT
// passport = { network, name, category, vmCategory, rallyA: { name, category, vmCategory }, rallyB: {…}, reward, endTime, organizerPub, genesisTx }
export const passportVault = (pp, provider) => new Contract(PassportVault,
  [pp.rallyA.vmCategory, pp.rallyB.vmCategory, BigInt(pp.reward), pp.organizerPub, BigInt(pp.endTime)], { provider });
/** A trophy of this rally category owned by pkh (plain or bonus). */
export const isTrophyOf = (category, pkhHex, u) => u.token?.category === category && !!u.token.nft
  && u.token.nft.capability === 'none' && u.token.nft.commitment.slice(0, 42) === '00' + pkhHex;
/** @param {{ passport: any, provider: any, ownerLock: Uint8Array, trophyA: any, trophyB: any, coins?: any[] }} args */
export async function buildPassportClaim({ passport, provider, ownerLock, trophyA, trophyB, coins = [] }) {
  const vault = passportVault(passport, provider);
  const v = (await vault.getUtxos()).find((u) => u.token?.category === passport.category && u.token.nft?.capability === 'minting');
  if (!v) throw new Error('This passport offer is over');
  const reward = BigInt(passport.reward);
  if (v.satoshis - reward < DUST) throw new Error('The passport pool is empty');
  const dust = trophyA.utxo.satoshis + trophyB.utxo.satoshis;
  const shortfall = DUST + CLAIM_FEE - dust;
  const { picked, sum } = shortfall > 0n ? pickCoins(coins, shortfall) : { picked: [], sum: 0n };
  const tb = new TransactionBuilder({ provider }).addInput(v, vault.unlock.claim())
    .addInput(trophyA.utxo, trophyA.unlocker).addInput(trophyB.utxo, trophyB.unlocker);
  picked.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  return {
    inputs: [trophyA, trophyB, ...picked].map((c, i) => ({ ...c, index: i + 1 })),
    builder: tb
      .addOutput({ to: vault.tokenAddress, amount: v.satoshis - reward, token: v.token })
      .addOutput({ to: ownerLock, amount: reward + dust + sum - DUST - CLAIM_FEE })
      .addOutput({ to: ownerLock, amount: DUST, token: nft({ category: passport.category }, binToHex(ownerLock.slice(3, 23))) }),
  };
}

// ---- addStall (RewardVault2): the organizer opens a stall mid-rally; the vault derives its minter address on chain.
// stall = { name, emoji, price, memberPrice, lock (P2PKH hex), presenceKey?, place?, tagline? }; id = 17.. (see the contract)
/** @param {{ rally: any, provider: any, signer: any, stall: any, feeCoin: any, changeTo: Uint8Array }} args */
export async function buildAddStall({ rally, provider, signer, stall, feeCoin, changeTo }) {
  if (rally.minter !== 3) throw new Error('Adding stalls needs a levy rally');
  if (!/^76a914[0-9a-f]{40}88ac$/.test(stall.lock)) throw new Error('An added stall is paid at a P2PKH address');
  const id = Math.max(16, ...rally.merchants.map((m) => m.id)) + 1;
  if (id > 127) throw new Error('No stall ids left');
  const merchant = { tagline: '', color: '#7a4a2b', ...stall, id, memberPrice: stall.memberPrice ?? stall.price };
  const next = { ...rally, merchants: [...rally.merchants, merchant] };
  checkRallyConfig({ ...next, rewardsInPool: 1 });
  const { vault, minters } = rallyContracts(next, provider);
  const vaultCoin = (await vault.getUtxos()).find((u) => isMintingCoin(rally, u));
  if (!vaultCoin) throw new Error('The vault is gone: the rally has been reclaimed');
  const lanes = 2n * DUST, fee = 2500n; // the vault input reveals its ~740-byte script
  if (feeCoin.utxo.satoshis < lanes + fee + DUST) throw new Error(`Fund the organizer key with at least ${lanes + fee + DUST} sats`);
  const builder = new TransactionBuilder({ provider })
    .addInput(vaultCoin, vault.unlock.addStall(signer, merchant.lock, BigInt(merchant.price), BigInt(merchant.memberPrice), BigInt(id), merchant.presenceKey ?? ''))
    .addInput(feeCoin.utxo, feeCoin.unlocker)
    .addOutput({ to: vault.tokenAddress, amount: vaultCoin.satoshis, token: vaultCoin.token })
    .addOutput({ to: minters[id].tokenAddress, amount: DUST, token: vaultCoin.token })
    .addOutput({ to: minters[id].tokenAddress, amount: DUST, token: vaultCoin.token })
    .addOutput({ to: changeTo, amount: feeCoin.utxo.satoshis - lanes - fee });
  return { builder, rally: next };
}
