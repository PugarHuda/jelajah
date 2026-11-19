// End-to-end on a real network with the app's own builders: a throwaway buyer buys 3 stamps and claims.
//   node scripts/smoke.mjs --network chipnet
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif, generatePrivateKey } from '@bitauth/libauth';
import { rallyContracts, buildStamp, buildClaim, isRallyNft } from '../src/lib/tx.js';

const { values: { network } } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' } } });
const rally = JSON.parse(readFileSync(new URL(`../src/rally.${network}.json`, import.meta.url)));
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
const need = rally.merchants.slice(0, rally.needed).reduce((s, m) => s + BigInt(m.price) + 3500n, 0n) + 5000n;
const funded = await new TransactionBuilder({ provider })
  .addInput(fund.utxo, fund.unlocker)
  .addOutput({ to: buyer.lock, amount: need })
  .addOutput({ to: organizer.lock, amount: fund.utxo.satoshis - need - 1000n })
  .send();
console.log('funded buyer      ', explorer + funded.txid);

const { minters, vault } = rallyContracts(rally, provider);
for (const m of rally.merchants.slice(0, rally.needed)) {
  const { builder } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: buyer.lock, coins: await buyer.coins() });
  const { txid } = await builder.send();
  console.log(`stamp ${m.emoji} ${m.name.padEnd(12)}`, explorer + txid);
}

const all = await buyer.coins();
const { builder } = await buildClaim({
  rally, provider, vault, buyerLock: buyer.lock,
  stamps: all.filter((c) => isRallyNft(rally, c.utxo)),
  coins: all.filter((c) => !c.utxo.token),
});
const { txid } = await builder.send();
console.log('claim + trophy    ', explorer + txid);
const left = (await buyer.coins()).filter((c) => isRallyNft(rally, c.utxo)).map((c) => c.utxo.token.nft.commitment.slice(0, 2));
console.log('buyer NFTs now    ', left, '(expect ["00"] = trophy)');

// the buyer key is throwaway: sweep the change and the trophy back to the organizer
const rest = await buyer.coins();
const sweep = new TransactionBuilder({ provider });
rest.forEach((c) => sweep.addInput(c.utxo, c.unlocker));
rest.filter((c) => c.utxo.token).forEach((c) => sweep.addOutput({ to: organizer.lock, amount: c.utxo.satoshis, token: c.utxo.token }));
const bchLeft = rest.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
sweep.addOutput({ to: organizer.lock, amount: bchLeft - 1000n });
console.log('swept back        ', explorer + (await sweep.send()).txid);
