// End-to-end on a real network with the app's own builders: a throwaway buyer buys 3 stamps and claims.
//   node scripts/smoke.mjs --network chipnet
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif, generatePrivateKey, hexToBin, binToHex } from '@bitauth/libauth';
import { rallyContracts, buildStamp, buildClaim, isRallyNft, mergeLevies, signPresence, pickLane, isVoucher } from '../src/lib/tx.js';

// --basic: just one set and its claim (no bonus tier, member, sponsored or added-stall stamps), e.g. to earn a trophy cheaply
const { values: { network, rally: rallyFile, buyer: buyerFile, basic } } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' }, rally: { type: 'string' }, buyer: { type: 'string' }, basic: { type: 'boolean' } } });
const rally = JSON.parse(readFileSync(rallyFile ?? new URL(`../src/rally.${network}.json`, import.meta.url)));
// presence stalls: sign as the stall's device would (CLI-made rallies keep device keys in scripts/.presence.<net>.json)
const presenceFile = new URL(`./.presence.${network}.json`, import.meta.url);
const devices = existsSync(presenceFile) ? JSON.parse(readFileSync(presenceFile)) : {};
// pick the lane first: the device's signature covers that exact minter coin
const presenceFor = async (m, lock) => {
  const lane = await pickLane(rally, minters[m.id]);
  return { lane, presence: m.presenceKey ? signPresence(hexToBin(devices[m.id]), rally, m.id, binToHex(lock.slice(3, 23)), lane) : undefined };
};
const provider = new ElectrumNetworkProvider(network);
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = network === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';

const wallet = (priv) => {
  const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(priv)));
  const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix }).address;
  const sig = new SignatureTemplate(priv);
  const coins = async () => (await provider.getUtxos(address)).map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() }));
  return { lock, address, sig, coins };
};
const organizer = wallet(decodePrivateKeyWif(JSON.parse(readFileSync(new URL(`./.organizer.${network}.json`, import.meta.url))).wif).privateKey);
// --buyer <file>: keep the buyer key (and its trophy) across runs, e.g. to redeem a passport later; otherwise throwaway
const buyerKey = buyerFile && existsSync(buyerFile) ? hexToBin(JSON.parse(readFileSync(buyerFile)).key) : generatePrivateKey();
if (buyerFile) writeFileSync(buyerFile, JSON.stringify({ key: binToHex(buyerKey) }));
const buyer = wallet(buyerKey);

// fund the buyer
// each stamp: price + stamp dust + change dust + fee; plus the claim fee. Leftovers are swept back below.
const tier = basic ? rally.needed : rally.bonusNeeded ?? rally.needed; // bonus rallies: go for the bonus tier
const need = rally.merchants.slice(0, tier).reduce((s, m) => s + BigInt(m.price) + BigInt(rally.levy ?? 0) + 3500n, 0n) + 5000n + (basic ? 0n : 3n * (BigInt(rally.levy ?? 0) + 6000n)); // + member, sponsored and added-stall stamps
// a kept buyer may already hold stamps and BCH from an earlier, interrupted run: top up only what is missing
const pkhHex = binToHex(buyer.lock.slice(3, 23));
const held = (await buyer.coins()).filter((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.slice(2, 42) === pkhHex);
const todo = rally.merchants.slice(0, tier).filter((m) => !held.some((c) => parseInt(c.utxo.token.nft.commitment.slice(0, 2), 16) === m.id));
const has = (await buyer.coins()).filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
const topUp = need - BigInt(rally.merchants.slice(0, tier).length - todo.length) * (BigInt(rally.levy ?? 0) + 6500n) - has;
if (topUp > 0n) {
  // all of the organizer's BCH coins in, so the change never falls under dust
  const own = (await organizer.coins()).filter((c) => !c.utxo.token);
  const total = own.reduce((t, c) => t + c.utxo.satoshis, 0n);
  const tb = new TransactionBuilder({ provider });
  own.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  const funded = await tb.addOutput({ to: buyer.lock, amount: topUp })
    .addOutput({ to: organizer.lock, amount: total - topUp - 200n - 160n * BigInt(own.length) }).send();
  console.log('funded buyer      ', explorer + funded.txid);
}

const { minters, vault } = rallyContracts(rally, provider);
for (const m of todo) {
  const { builder } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, coins: await buyer.coins(), ...(await presenceFor(m, buyer.lock)) });
  const { txid } = await builder.send();
  console.log(`stamp ${m.emoji} ${m.name.padEnd(12)}`, explorer + txid);
}

const merged = await mergeLevies({ rally, provider, vault }); // levy rallies: fold levies into the pool, unsigned
if (merged) console.log('merge levies      ', explorer + merged.txid);
const all = await buyer.coins();
const { builder } = await buildClaim({
  rally, provider, vault, buyerLock: buyer.lock, vaultUtxo: merged ?? undefined, bonus: !basic && !!rally.bonusNeeded,
  stamps: all.filter((c) => isRallyNft(rally, c.utxo)),
  coins: all.filter((c) => !c.utxo.token),
});
const { txid } = await builder.send();
console.log('claim + trophy    ', explorer + txid);
const left = (await buyer.coins()).filter((c) => isRallyNft(rally, c.utxo)).map((c) => c.utxo.token.nft.commitment.slice(0, 2));
console.log('buyer NFTs now    ', left, '(expect ["00"] = trophy)');

// StampMinter2 rallies: the fresh trophy is a membership card -> one more stamp at the member price, trophy comes back
if (!basic && (rally.minter ?? 1) >= 2) {
  const coins = await buyer.coins();
  const trophy = coins.find((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.startsWith('00'));
  const m = rally.merchants[0];
  const { builder: b } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, coins: coins.filter((c) => !c.utxo.token), trophy, ...(await presenceFor(m, buyer.lock)) });
  console.log(`member stamp ${m.emoji} (${m.memberPrice} sats)`, explorer + (await b.send()).txid);
  const back = (await buyer.coins()).some((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.startsWith('00'));
  if (!back) throw new Error('trophy did not come back');
  console.log('trophy still held  ', back);
}

// sponsored rallies: the sponsor (organizer key here) hands the buyer one voucher, which pays part of a stamp
if (!basic && rally.sponsor) {
  const v = (await organizer.coins()).find((c) => isVoucher(rally, c.utxo));
  const fee = (await organizer.coins()).filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))[0];
  const give = await new TransactionBuilder({ provider }).addInput(v.utxo, v.unlocker).addInput(fee.utxo, fee.unlocker)
    .addOutput({ to: buyer.lock, amount: v.utxo.satoshis, token: v.utxo.token })
    .addOutput({ to: organizer.lock, amount: fee.utxo.satoshis - 1000n }).send();
  console.log('voucher to buyer  ', explorer + give.txid);
  const coins = await buyer.coins();
  const m = rally.merchants[2];
  const { builder: b } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, voucher: coins.find((c) => isVoucher(rally, c.utxo)),
    coins: coins.filter((c) => !c.utxo.token), trophy: coins.find((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.startsWith('00')), ...(await presenceFor(m, buyer.lock)) });
  console.log(`sponsored stamp ${m.emoji} (${rally.sponsor.value} sats off)`, explorer + (await b.send()).txid);
}

// a stall opened mid-rally (RewardVault2.addStall): buy there too
const added = rally.merchants.find((m) => m.id >= 17);
if (!basic && added) {
  const coins = await buyer.coins();
  const { builder: b } = await buildStamp({ rally, provider, minters, merchantId: added.id, buyerLock: buyer.lock, coins: coins.filter((c) => !c.utxo.token), ...(await presenceFor(added, buyer.lock)) });
  console.log(`stamp at added stall #${added.id} ${added.emoji}`, explorer + (await b.send()).txid);
}

// the buyer key is throwaway: sweep the change and the trophy back to the organizer
const rest = await buyer.coins();
const sweep = new TransactionBuilder({ provider });
rest.forEach((c) => sweep.addInput(c.utxo, c.unlocker));
// a kept buyer keeps its trophies (for a passport); everything else goes back
const keep = (c) => buyerFile && c.utxo.token?.nft?.commitment.startsWith('00');
rest.filter((c) => c.utxo.token && !keep(c)).forEach((c) => sweep.addOutput({ to: organizer.lock, amount: c.utxo.satoshis, token: c.utxo.token }));
rest.filter(keep).forEach((c) => sweep.addOutput({ to: buyer.lock, amount: c.utxo.satoshis, token: c.utxo.token }));
const bchLeft = rest.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
sweep.addOutput({ to: organizer.lock, amount: bchLeft - 200n - 200n * BigInt(rest.length) }); // ~150-byte inputs + token outputs
console.log('swept back        ', explorer + (await sweep.send()).txid);
