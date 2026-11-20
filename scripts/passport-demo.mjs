// Redeem a passport with a buyer that holds a trophy of each rally (made by smoke.mjs --buyer <file> on both rallies).
//   node scripts/passport-demo.mjs --network chipnet --buyer scripts/.buyer.chipnet.json
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif, hexToBin, binToHex } from '@bitauth/libauth';
import { buildPassportClaim, isTrophyOf } from '../src/lib/tx.js';

const { values: opt } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' }, buyer: { type: 'string' } } });
const { network } = opt;
const json = (f) => JSON.parse(readFileSync(f));
const passport = json(`scripts/passport.${network}.json`);
const provider = new ElectrumNetworkProvider(network);
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = network === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';
const wallet = (priv) => {
  const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(priv)));
  const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix }).address;
  const sig = new SignatureTemplate(priv);
  return { lock, coins: async () => (await provider.getUtxos(address)).map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() })) };
};
const organizer = wallet(decodePrivateKeyWif(json(`scripts/.organizer.${network}.json`).wif).privateKey);
const buyer = wallet(hexToBin(json(opt.buyer).key));
const pkh = binToHex(buyer.lock.slice(3, 23));

// a little BCH for the fee (the trophies' dust covers most of it)
const fund = (await organizer.coins()).filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))[0];
console.log('fee coin      ', explorer + (await new TransactionBuilder({ provider }).addInput(fund.utxo, fund.unlocker)
  .addOutput({ to: buyer.lock, amount: 4000n }).addOutput({ to: organizer.lock, amount: fund.utxo.satoshis - 4000n - 500n }).send()).txid);
const all = await buyer.coins();
const trophyA = all.find((c) => isTrophyOf(passport.rallyA.category, pkh, c.utxo));
const trophyB = all.find((c) => isTrophyOf(passport.rallyB.category, pkh, c.utxo));
if (!trophyA || !trophyB) throw new Error('the buyer needs a trophy of each rally: run smoke.mjs --buyer on both first');
const { builder } = await buildPassportClaim({ passport, provider, ownerLock: buyer.lock, trophyA, trophyB, coins: all.filter((c) => !c.utxo.token) });
console.log('passport claim', explorer + (await builder.send()).txid);
const rest = await buyer.coins();
const pass = rest.find((c) => c.utxo.token?.category === passport.category);
console.log('buyer holds a Passport NFT for its pkh:', pass?.utxo.token.nft.commitment === pkh);
const sweep = new TransactionBuilder({ provider });
rest.forEach((c) => sweep.addInput(c.utxo, c.unlocker));
rest.filter((c) => c.utxo.token).forEach((c) => sweep.addOutput({ to: organizer.lock, amount: c.utxo.satoshis, token: c.utxo.token }));
sweep.addOutput({ to: organizer.lock, amount: rest.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n) - 1500n });
console.log('swept back    ', explorer + (await sweep.send()).txid);
process.exit(0);
