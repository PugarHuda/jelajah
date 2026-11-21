// Buy one stamp on the live rally with the organizer's own key (a real covenant purchase, no wallet app needed).
// With the demo rally the stall is paid to the organizer, so this costs only the levy, the stamp dust and the fee.
//   node scripts/buy-one.mjs --network mainnet --stall 1
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif } from '@bitauth/libauth';
import { rallyContracts, buildStamp } from '../src/lib/tx.js';

const { values: { network, stall } } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' }, stall: { type: 'string', default: '1' } } });
const rally = JSON.parse(readFileSync(new URL(`../src/rally.${network}.json`, import.meta.url)));
const m = rally.merchants.find((x) => x.id === Number(stall));
if (!m) throw new Error(`no stall ${stall}`);
if (m.presenceKey) throw new Error('this stall needs its device to sign: use the app');
const provider = new ElectrumNetworkProvider(network);
const key = decodePrivateKeyWif(JSON.parse(readFileSync(new URL(`./.organizer.${network}.json`, import.meta.url))).wif).privateKey;
const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key)));
const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest' }).address;
const sig = new SignatureTemplate(key);
const coins = (await provider.getUtxos(address)).filter((u) => !u.token).map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() }));
const { minters } = rallyContracts(rally, provider);
const { builder } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: lock, coins });
const { txid } = await builder.send();
console.log(`stamp ${m.emoji} ${m.name}`, network === 'mainnet' ? `https://blockchair.com/bitcoin-cash/transaction/${txid}` : `https://chipnet.imaginary.cash/tx/${txid}`);
process.exit(0);
