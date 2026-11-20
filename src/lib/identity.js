// Jelajah ID: link a Bitcoin Cash address and a Nostr key, each key vouching for the other, with no identity server.
//
//  1. BCH side (proof of control of the address): the wallet spends a coin *from that address* in a transaction whose
//     OP_RETURN commits to the statement and the Nostr key:  "JLID" ‖ sha256(statement) ‖ nostr pubkey (32 bytes).
//  2. Nostr side: the Nostr key signs a replaceable event (kind 30078, d = "jelajah-bch-link") whose content is that
//     statement, tagged ["i", "bch:<address>", "<proof txid>"] so anyone can find it by Nostr key OR by BCH address.
//  3. Verification needs only public data: the event's Schnorr signature, the proof tx's OP_RETURN, and the address that
//     funded the proof tx's first input. Neither private key is shared or reused across the two networks.
// Used by the app (#/identity) and by the standalone verifier (scripts/verify-identity.mjs).
import { TransactionBuilder } from 'cashscript';
import { binToHex, hexToBin, sha256, utf8ToBin, decodeTransaction, cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { verifyEvent } from 'nostr-tools/pure';

// nostr-tools caches a passed verification on the event object (a symbol property that object spread copies), so a
// tampered copy of a verified event would skip the check: always verify a plain JSON copy.
const verifyFresh = (event) => verifyEvent(JSON.parse(JSON.stringify(event)));

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export const LINK_KIND = 30078;
export const LINK_D = 'jelajah-bch-link';
export const LOGIN_KIND = 27235; // a signed one-off event answering a login challenge (never published)
const MAGIC = '4a4c4944'; // "JLID"

/** The text both keys commit to. Deterministic, so a verifier can rebuild it from the event alone. */
export const statement = ({ address, nostrPubkey }) =>
  `Jelajah ID v1: the Bitcoin Cash address ${address} and the Nostr key ${nostrPubkey} belong to the same person.`;

/** OP_RETURN payload of the BCH proof (pushes: "JLID", sha256(statement), nostr pubkey). */
export const proofPushes = (text, nostrPubkey) => ['JLID', `0x${binToHex(sha256.hash(utf8ToBin(text)))}`, `0x${nostrPubkey}`];

/** The BCH proof tx: every input comes from the claimed address, so only that address's key could have signed it.
 *  coins: [{ utxo, unlocker }] at that address (BCH only). */
export function buildProofTx({ provider, coins, address, nostrPubkey }) {
  if (typeof cashAddressToLockingBytecode(address) === 'string') throw new Error('invalid BCH address');
  const own = coins.filter((c) => !c.utxo.token); // the caller passes the coins at `address`; verifyLink re-checks input 0 on chain
  const total = own.reduce((s, c) => s + c.utxo.satoshis, 0n);
  const fee = 300n + 150n * BigInt(own.length);
  if (total < fee + 546n) throw new Error(`Send at least ${fee + 546n} sats to ${address} first: the proof spends a coin from that very address`);
  const tb = new TransactionBuilder({ provider });
  own.forEach((c) => tb.addInput(c.utxo, c.unlocker));
  tb.addOpReturnOutput(proofPushes(statement({ address, nostrPubkey }), nostrPubkey));
  return { builder: tb.addOutput({ to: address, amount: total - fee }), inputs: own };
}

/** The Nostr event template that publishes the link (sign it with the Nostr key: NIP-07 or a local key). */
export const linkEvent = ({ address, nostrPubkey, txid, network }) => ({
  kind: LINK_KIND,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', LINK_D], ['i', `bch:${address}`, txid], ['network', network], ['alt', 'Jelajah ID: a Bitcoin Cash address linked to this Nostr key']],
  content: statement({ address, nostrPubkey }),
});

/** Check a link event end to end.
 *  @returns {Promise<{ ok: boolean, reason?: string, address?: string, nostrPubkey?: string, txid?: string, created_at?: number }>} */
export async function verifyLink(event, provider) {
  const fail = (reason) => ({ ok: false, reason, nostrPubkey: event?.pubkey });
  if (!event || event.kind !== LINK_KIND || !verifyFresh(event)) return fail('the Nostr signature does not verify');
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === LINK_D)) return fail('not a Jelajah ID event');
  const i = event.tags.find((t) => t[0] === 'i' && t[1]?.startsWith('bch:'));
  if (!i || !/^[0-9a-f]{64}$/.test(i[2] ?? '')) return fail('no BCH address or proof txid in the event');
  const address = i[1].slice(4), txid = i[2];
  if (event.content !== statement({ address, nostrPubkey: event.pubkey })) return fail('the signed statement does not match the address and key');
  const lock = cashAddressToLockingBytecode(address);
  if (typeof lock === 'string') return fail('invalid BCH address');
  let tx;
  try { tx = decodeTransaction(hexToBin(await provider.getRawTransaction(txid))); } catch { return fail('the proof transaction is not on this network'); }
  if (typeof tx === 'string') return fail('the proof transaction does not decode');
  const want = [...proofPushes(event.content, event.pubkey)];
  const opret = tx.outputs.map((o) => binToHex(o.lockingBytecode)).find((h) => h.startsWith('6a'));
  const has = (hex) => opret?.includes(hex.replace(/^0x/, ''));
  if (!opret || !has(MAGIC) || !has(want[1]) || !has(want[2])) return fail('the proof transaction does not commit to this statement and key');
  // the first input must have been the claimed address's coin: only its key could sign it
  const prev = decodeTransaction(hexToBin(await provider.getRawTransaction(binToHex(tx.inputs[0].outpointTransactionHash))));
  if (typeof prev === 'string' || binToHex(prev.outputs[tx.inputs[0].outpointIndex].lockingBytecode) !== binToHex(lock.bytecode))
    return fail('the proof was not spent from the claimed address');
  return { ok: true, address, nostrPubkey: event.pubkey, txid, created_at: event.created_at };
}

/** Find link events by Nostr key (hex) or by BCH address; newest first. pool: a nostr-tools SimplePool.
 *  @param {any} pool @param {{ nostrPubkey?: string, address?: string }} who @param {string[]} [relays] */
export async function findLinks(pool, { nostrPubkey, address }, relays = RELAYS) {
  const filter = { kinds: [LINK_KIND], '#d': [LINK_D], ...(nostrPubkey ? { authors: [nostrPubkey] } : {}), ...(address ? { '#i': [`bch:${address}`] } : {}) };
  const events = await pool.querySync(relays, filter, { maxWait: 4000 });
  return events.sort((a, b) => b.created_at - a.created_at);
}

/** Login: the app hands out a random challenge; the user signs a one-off event with their Nostr key; the app checks
 *  the signature and freshness, then resolves the verified BCH address from the published link. */
export const loginChallenge = () => binToHex(crypto.getRandomValues(new Uint8Array(16)));
export const loginEvent = (challenge, origin) => ({ kind: LOGIN_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge], ['u', origin]], content: 'Log in to a Jelajah ID app' });
export function checkLogin(event, challenge, maxAge = 300) {
  if (!event || event.kind !== LOGIN_KIND || !verifyFresh(event)) return 'bad signature';
  if (!event.tags.some((t) => t[0] === 'challenge' && t[1] === challenge)) return 'wrong challenge';
  if (Math.abs(Date.now() / 1000 - event.created_at) > maxAge) return 'stale answer';
  return null;
}

export const plainAddress = (lockOrAddress, prefix) =>
  typeof lockOrAddress === 'string' ? lockOrAddress : lockingBytecodeToCashAddress({ bytecode: lockOrAddress, prefix }).address;
