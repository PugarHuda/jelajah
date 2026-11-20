// End-to-end on a real network with the app's own builders: a throwaway buyer buys 3 stamps and claims.
//   node scripts/smoke.mjs --network chipnet
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif, generatePrivateKey, hexToBin, binToHex } from '@bitauth/libauth';
import { rallyContracts, buildStamp, buildClaim, isRallyNft, mergeLevies, signPresence } from '../src/lib/tx.js';

const { values: { network, rally: rallyFile } } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' }, rally: { type: 'string' } } });
const rally = JSON.parse(readFileSync(rallyFile ?? new URL(`../src/rally.${network}.json`, import.meta.url)));
// presence stalls: sign as the stall's device would (CLI-made rallies keep device keys in scripts/.presence.<net>.json)
const presenceFile = new URL(`./.presence.${network}.json`, import.meta.url);
const devices = existsSync(presenceFile) ? JSON.parse(readFileSync(presenceFile)) : {};
const presenceFor = (m, lock) => (m.presenceKey ? signPresence(hexToBin(devices[m.id]), rally, m.id, binToHex(lock.slice(3, 23))) : undefined);
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
const buyer = wallet(generatePrivateKey());

// fund the buyer
const fund = (await organizer.coins()).filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))[0];
// each stamp: price + stamp dust + change dust + fee; plus the claim fee. Leftovers are swept back below.
const tier = rally.bonusNeeded ?? rally.needed; // bonus rallies: go for the bonus tier
const need = rally.merchants.slice(0, tier).reduce((s, m) => s + BigInt(m.price) + BigInt(rally.levy ?? 0) + 3500n, 0n) + 5000n + BigInt(rally.levy ?? 0);
const funded = await new TransactionBuilder({ provider })
  .addInput(fund.utxo, fund.unlocker)
  .addOutput({ to: buyer.lock, amount: need })
  .addOutput({ to: organizer.lock, amount: fund.utxo.satoshis - need - 1000n })
  .send();
console.log('funded buyer      ', explorer + funded.txid);

const { minters, vault } = rallyContracts(rally, provider);
for (const m of rally.merchants.slice(0, tier)) {
  const { builder } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, coins: await buyer.coins(), presence: presenceFor(m, buyer.lock) });
  const { txid } = await builder.send();
  console.log(`stamp ${m.emoji} ${m.name.padEnd(12)}`, explorer + txid);
}

const merged = await mergeLevies({ rally, provider, vault }); // levy rallies: fold levies into the pool, unsigned
if (merged) console.log('merge levies      ', explorer + merged.txid);
const all = await buyer.coins();
const { builder } = await buildClaim({
  rally, provider, vault, buyerLock: buyer.lock, vaultUtxo: merged ?? undefined, bonus: !!rally.bonusNeeded,
  stamps: all.filter((c) => isRallyNft(rally, c.utxo)),
  coins: all.filter((c) => !c.utxo.token),
});
const { txid } = await builder.send();
console.log('claim + trophy    ', explorer + txid);
const left = (await buyer.coins()).filter((c) => isRallyNft(rally, c.utxo)).map((c) => c.utxo.token.nft.commitment.slice(0, 2));
console.log('buyer NFTs now    ', left, '(expect ["00"] = trophy)');

// StampMinter2 rallies: the fresh trophy is a membership card -> one more stamp at the member price, trophy comes back
if ((rally.minter ?? 1) >= 2) {
  const coins = await buyer.coins();
  const trophy = coins.find((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.startsWith('00'));
  const m = rally.merchants[0];
  const { builder: b } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, coins: coins.filter((c) => !c.utxo.token), trophy, presence: presenceFor(m, buyer.lock) });
  console.log(`member stamp ${m.emoji} (${m.memberPrice} sats)`, explorer + (await b.send()).txid);
  const back = (await buyer.coins()).some((c) => isRallyNft(rally, c.utxo) && c.utxo.token.nft.commitment.startsWith('00'));
  if (!back) throw new Error('trophy did not come back');
  console.log('trophy still held  ', back);
}

// the buyer key is throwaway: sweep the change and the trophy back to the organizer
const rest = await buyer.coins();
const sweep = new TransactionBuilder({ provider });
rest.forEach((c) => sweep.addInput(c.utxo, c.unlocker));
rest.filter((c) => c.utxo.token).forEach((c) => sweep.addOutput({ to: organizer.lock, amount: c.utxo.satoshis, token: c.utxo.token }));
const bchLeft = rest.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
sweep.addOutput({ to: organizer.lock, amount: bchLeft - 1000n });
console.log('swept back        ', explorer + (await sweep.send()).txid);
