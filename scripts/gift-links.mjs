// Fund N gift links on mainnet so newcomers can try a full set with real sats (the #/gift page sweeps one into their wallet).
//   SOLIDCASH_MNEMONIC_MAINNET="$(cut -d= -f2- solidcash/.env.mainnet)" node scripts/gift-links.mjs --count 5 --sats 14000
// Keys live in scripts/.gifts.mainnet.json (gitignored). Rerunning reuses them and only funds the ones still empty.
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
  deriveHdPrivateNodeFromSeed, deriveSeedFromBip39Mnemonic, deriveHdPath, generatePrivateKey, encodePrivateKeyWif,
  decodePrivateKeyWif, secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

const { values: o } = parseArgs({ options: { count: { type: 'string', default: '5' }, sats: { type: 'string', default: '14000' }, dry: { type: 'boolean', default: false } } });
const N = Number(o.count), SATS = BigInt(o.sats);
const FILE = new URL('./.gifts.mainnet.json', import.meta.url);
const SITE = 'https://jelajah-bch.vercel.app/#/gift/';
const addr = (k) => lockingBytecodeToCashAddress({ bytecode: encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(k))), prefix: 'bitcoincash' }).address;

const mnemonic = process.env.SOLIDCASH_MNEMONIC_MAINNET;
if (!mnemonic) throw new Error('set SOLIDCASH_MNEMONIC_MAINNET (see the header)');
const funder = deriveHdPath(deriveHdPrivateNodeFromSeed(deriveSeedFromBip39Mnemonic(mnemonic), { throwErrors: true }), "m/44'/60'/0'/0/0").privateKey;
const from = addr(funder);

const gifts = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
while (gifts.length < N) gifts.push({ wif: encodePrivateKeyWif(generatePrivateKey(), 'mainnet') });
writeFileSync(FILE, JSON.stringify(gifts, null, 1), { mode: 0o600 }); // saved before any money moves; owner-only (they are keys)
chmodSync(FILE, 0o600);

const provider = new ElectrumNetworkProvider('mainnet');
const todo = [];
for (const g of gifts.slice(0, N)) {
  const a = addr(decodePrivateKeyWif(g.wif).privateKey);
  const held = (await provider.getUtxos(a)).reduce((s, u) => s + u.satoshis, 0n);
  if (held < SATS) todo.push(a);
}
const coins = (await provider.getUtxos(from)).filter((u) => !u.token);
const total = coins.reduce((s, u) => s + u.satoshis, 0n);
const fee = 250n + 150n * BigInt(coins.length) + 40n * BigInt(todo.length);
const change = total - SATS * BigInt(todo.length) - fee;
console.log(`funder ${from}: ${total} sats; funding ${todo.length} of ${N} links at ${SATS} sats; change ${change}`);
if (todo.length && !o.dry) {
  if (change < 546n) throw new Error('not enough in the funder');
  const tb = new TransactionBuilder({ provider }).addInputs(coins, new SignatureTemplate(funder).unlockP2PKH());
  todo.forEach((a) => tb.addOutput({ to: a, amount: SATS }));
  const { txid } = await tb.addOutput({ to: from, amount: change }).send();
  console.log(`funded: https://blockchair.com/bitcoin-cash/transaction/${txid}`);
}
console.log('\nGift links (each one pays for a full set; whoever opens it first takes it):');
gifts.slice(0, N).forEach((g, i) => console.log(`${i + 1}. ${SITE}${g.wif}`));
process.exit(0);
