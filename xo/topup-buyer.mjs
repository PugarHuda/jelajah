// Send some sats from the rally organizer to the XO account's fixed buyer address (BCH only, no tokens).
//   NET=mainnet node xo/topup-buyer.mjs 3500     (or `all`: everything the organizer has, no change)
import { readFileSync } from 'node:fs';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { decodePrivateKeyWif, secp256k1, hash160, encodeLockingBytecodeP2pkh, hexToBin } from '@bitauth/libauth';

const net = process.env.NET === 'mainnet' ? 'mainnet' : 'chipnet';
const all = process.argv[2] === 'all';
const here = (p) => new URL(p, import.meta.url);
const key = decodePrivateKeyWif(JSON.parse(readFileSync(here(`../scripts/.organizer.${net}.json`))).wif).privateKey;
const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key)));
const buyer = hexToBin(JSON.parse(readFileSync(here(`.wallet.${net}.json`))).buyer);
const provider = new ElectrumNetworkProvider(net);
const { lockingBytecodeToCashAddress } = await import('@bitauth/libauth');
const coins = (await provider.getUtxos(lockingBytecodeToCashAddress({ bytecode: lock, prefix: net === 'mainnet' ? 'bitcoincash' : 'bchtest' }).address)).filter((u) => !u.token);
const total = coins.reduce((s, u) => s + u.satoshis, 0n);
const fee = 250n + 160n * BigInt(coins.length);
const amount = all ? total - fee + 34n : BigInt(process.argv[2]); // no change output saves its 34 bytes
if (!all && total - amount - fee < 546n) throw new Error(`organizer has ${total} sats`);
const sig = new SignatureTemplate(key);
const tb = new TransactionBuilder({ provider });
coins.forEach((u) => tb.addInput(u, sig.unlockP2PKH()));
tb.addOutput({ to: buyer, amount });
if (!all) tb.addOutput({ to: lock, amount: total - amount - fee });
const { txid } = await tb.send();
console.log(`topped up the XO buyer with ${amount}: ${txid} (organizer left ${total - amount - fee})`);
process.exit(0);
