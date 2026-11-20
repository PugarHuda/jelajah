// Jelajah ID end to end with local keys: link this project's organizer BCH address to a Nostr key, publish, discover,
// verify, then log in with a challenge. The Nostr key is kept in scripts/.nostr.<network>.json (gitignored).
//   node scripts/identity-demo.mjs --network mainnet
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { decodePrivateKeyWif, secp256k1, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, hexToBin, binToHex } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, buildProofTx, linkEvent, findLinks, verifyLink, loginChallenge, loginEvent, checkLogin, findVerified } from '../src/lib/identity.js';

const { values: { network } } = parseArgs({ options: { network: { type: 'string', default: 'mainnet' } } });
const provider = new ElectrumNetworkProvider(network);
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = network === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';

// BCH identity: the organizer key
const priv = decodePrivateKeyWif(JSON.parse(readFileSync(`scripts/.organizer.${network}.json`)).wif).privateKey;
const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(priv)));
const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix }).address;
// Nostr identity: a key of its own (never the BCH key)
const nostrFile = `scripts/.nostr.${network}.json`;
if (!existsSync(nostrFile)) writeFileSync(nostrFile, JSON.stringify({ sk: binToHex(generateSecretKey()) }));
const sk = hexToBin(JSON.parse(readFileSync(nostrFile)).sk);
const nostrPubkey = getPublicKey(sk);
console.log('BCH  ', address);
console.log('Nostr', nip19.npubEncode(nostrPubkey));

// 1. BCH proof, spent from the address itself
const sig = new SignatureTemplate(priv);
const coins = (await provider.getUtxos(address)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis)).slice(0, 1)
  .map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() }));
const { builder } = buildProofTx({ provider, coins, address, nostrPubkey });
const { txid } = await builder.send();
console.log('BCH proof tx      ', explorer + txid);

// 2. Nostr side, published to public relays
const pool = new SimplePool();
const event = finalizeEvent(linkEvent({ address, nostrPubkey, txid, network }), sk);
const published = await Promise.allSettled(pool.publish(RELAYS, event));
console.log('published to      ', published.filter((p) => p.status === 'fulfilled').length, 'of', RELAYS.length, 'relays; event', event.id);

// 3. discovery + verification from public data only, both ways
await new Promise((r) => setTimeout(r, 2500));
for (const [label, q] of [['by Nostr key', { nostrPubkey }], ['by BCH address', { address }]]) {
  const found = await findLinks(pool, q);
  const r = found.length ? await verifyLink(found[0], provider) : { ok: false, reason: 'not found' };
  console.log(`discover ${label.padEnd(14)}`, r.ok ? `VERIFIED -> ${r.address}` : `FAILED: ${r.reason}`);
}

// 4. challenge-response login
const challenge = loginChallenge();
const answer = finalizeEvent(loginEvent(challenge, 'https://jelajah-bch.vercel.app'), sk);
const problem = checkLogin(answer, challenge, 'https://jelajah-bch.vercel.app');
const verified = await findVerified(pool, { nostrPubkey: answer.pubkey }, provider);
console.log('login             ', problem ?? (verified?.ok ? `logged in as ${verified.address}` : 'no verified link'));
console.log('forged login      ', checkLogin({ ...answer, tags: [['challenge', 'ff'.repeat(16)]] }, challenge, 'https://jelajah-bch.vercel.app') ?? 'ACCEPTED?!');
pool.close(RELAYS);
process.exit(0);
