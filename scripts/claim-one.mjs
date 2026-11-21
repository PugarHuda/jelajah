// Claim one set on the live rally with the organizer's own key: merge the levies into the pool, then burn 3 stamps
// for the reward + a trophy. The partner of buy-one.mjs.
//   node scripts/claim-one.mjs --network mainnet
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, decodePrivateKeyWif } from '@bitauth/libauth';
import { rallyContracts, buildClaim, isRallyNft, mergeLevies } from '../src/lib/tx.js';

const { values: { network } } = parseArgs({ options: { network: { type: 'string', default: 'chipnet' } } });
const rally = JSON.parse(readFileSync(new URL(`../src/rally.${network}.json`, import.meta.url)));
const provider = new ElectrumNetworkProvider(network);
const key = decodePrivateKeyWif(JSON.parse(readFileSync(new URL(`./.organizer.${network}.json`, import.meta.url))).wif).privateKey;
const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key)));
const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix: network === 'mainnet' ? 'bitcoincash' : 'bchtest' }).address;
const explorer = (id) => network === 'mainnet' ? `https://blockchair.com/bitcoin-cash/transaction/${id}` : `https://chipnet.imaginary.cash/tx/${id}`;
const sig = new SignatureTemplate(key);
const { vault } = rallyContracts(rally, provider);
const merged = await mergeLevies({ rally, provider, vault }); // levy rallies: anyone can fold levies into the pool, unsigned
if (merged) console.log('merge levies', explorer(merged.txid));
const all = (await provider.getUtxos(address)).map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() }));
const { builder } = await buildClaim({ rally, provider, vault, vaultUtxo: merged ?? undefined, buyerLock: lock, stamps: all.filter((c) => isRallyNft(rally, c.utxo)), coins: all.filter((c) => !c.utxo.token) });
const { txid } = await builder.send();
console.log('claim + trophy', explorer(txid));
process.exit(0);
