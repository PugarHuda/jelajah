// Jelajah ID: link a Bitcoin Cash address and a Nostr key, each key vouching for the other, with no identity server.
//
//  1. BCH side (proof of control of the address): the wallet spends a coin *from that address* in a transaction whose
//     OP_RETURN is NIP-39's verification text naming the Nostr key ("Verifying that I control the following Nostr
//     public key: npub1…"). v1 proofs committed "JLID" ‖ sha256(statement) ‖ nostr pubkey instead; both verify.
//  2. Nostr side: the Nostr key signs a replaceable event (kind 30078, d = "jelajah-bch-link") whose content is that
//     statement, tagged ["i", "bch:<address>", "<proof txid>"] so anyone can find it by Nostr key OR by BCH address.
//     The same link is also published as a standard NIP-39 claim (kind 10011, ["i", "bch:<q…>", "tx:<txid>"]), the
//     on-chain proof form TwinKey specifies, so other Nostr apps and verifiers can read it.
//  3. Verification needs only public data: the event's Schnorr signature, the proof tx's OP_RETURN, and the address that
//     funded the proof tx's first input. Neither private key is shared or reused across the two networks.
// Used by the app (#/identity) and by the standalone verifier (scripts/verify-identity.mjs).
import { TransactionBuilder } from 'cashscript';
import { binToHex, hexToBin, sha256, utf8ToBin, decodeTransaction, decodeAuthenticationInstructions, cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { verifyEvent } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

// nostr-tools caches a passed verification on the event object (a symbol property that object spread copies), so a
// tampered copy of a verified event would skip the check: always verify a plain JSON copy.
const verifyFresh = (event) => verifyEvent(JSON.parse(JSON.stringify(event)));

export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export const LINK_KIND = 30078;
export const LINK_D = 'jelajah-bch-link';
export const NIP39_KIND = 10011;
export const LOGIN_KIND = 27235; // a signed one-off event answering a login challenge (never published)
const MAGIC = '4a4c4944'; // "JLID"

/** The text both keys commit to. Deterministic, so a verifier can rebuild it from the event alone. */
export const statement = ({ address, nostrPubkey }) =>
  `Jelajah ID v1: the Bitcoin Cash address ${address} and the Nostr key ${nostrPubkey} belong to the same person.`;

/** v1 OP_RETURN payload (pushes: "JLID", sha256(statement), nostr pubkey). Still verified, no longer made. */
export const proofPushes = (text, nostrPubkey) => ['JLID', `0x${binToHex(sha256.hash(utf8ToBin(text)))}`, `0x${nostrPubkey}`];
/** NIP-39's verification text: the v2 OP_RETURN, and what other NIP-39 verifiers look for. */
export const nip39Text = (nostrPubkey) => `Verifying that I control the following Nostr public key: ${npubEncode(nostrPubkey)}`;
/** NIP-39 identity for an address: the cashaddr payload without prefix, platform bch (mainnet) or bchtest. */
export const nip39Id = (address) => { const [prefix, payload] = address.split(':'); return `${prefix === 'bitcoincash' ? 'bch' : 'bchtest'}:${payload}`; };

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
  tb.addOpReturnOutput([nip39Text(nostrPubkey)]);
  return { builder: tb.addOutput({ to: address, amount: total - fee }), inputs: own };
}

/** The Nostr event template that publishes the link (sign it with the Nostr key: NIP-07 or a local key). */
export const linkEvent = ({ address, nostrPubkey, txid, network }) => ({
  kind: LINK_KIND,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['d', LINK_D], ['i', `bch:${address}`, txid], ['network', network], ['alt', 'Jelajah ID: a Bitcoin Cash address linked to this Nostr key']],
  content: statement({ address, nostrPubkey }),
});

/** The NIP-39 list to publish: the author's current kind-10011 tags, minus any older claim for this address, plus ours.
 *  It is replaceable, so keeping the other tags matters (other platforms, other addresses). */
export const nip39Event = (current, { address, txid }) => {
  const id = nip39Id(address);
  const keep = (current?.tags ?? []).filter((t) => !(t[0] === 'i' && t[1] === id));
  return { kind: NIP39_KIND, created_at: Math.max(Math.floor(Date.now() / 1000), (current?.created_at ?? 0) + 1), tags: [...keep, ['i', id, `tx:${txid}`]], content: current?.content ?? '' };
};

/** The proof tx spends a coin of `address` and its OP_RETURN names this Nostr key (v2 NIP-39 text, or v1 commitment).
 *  Returns null when it holds, else the reason. */
async function checkProofTx(provider, txid, address, nostrPubkey, v1Statement) {
  const lock = cashAddressToLockingBytecode(address);
  if (typeof lock === 'string') return 'invalid BCH address';
  // a key proves control: P2PKH only (a P2SH script could let anyone spend)
  if (!/^76a914[0-9a-f]{40}88ac$/.test(binToHex(lock.bytecode))) return 'only a P2PKH address can be claimed';
  const tx = await fetchTx(provider, txid);
  if (typeof tx === 'string') return tx;
  const opret = tx.outputs.map((o) => binToHex(o.lockingBytecode)).find((h) => h.startsWith('6a'));
  const has = (hex) => opret?.includes(hex.replace(/^0x/, ''));
  const v2 = has(binToHex(utf8ToBin(nip39Text(nostrPubkey))));
  const v1 = v1Statement !== undefined && has(MAGIC) && proofPushes(v1Statement, nostrPubkey).slice(1).every(has);
  if (!opret || !(v1 || v2)) return 'the proof transaction does not commit to this statement and key';
  // a coin of the claimed address, signed with SIGHASH_ALL: the key committed to every output, the OP_RETURN included.
  // (SIGHASH_SINGLE/ANYONECANPAY signatures, e.g. from a coinjoin, would let someone else attach their own OP_RETURN.)
  for (const input of tx.inputs.slice(0, MAX_INPUTS)) {
    const sigPush = decodeAuthenticationInstructions(input.unlockingBytecode)[0];
    const sig = sigPush && 'data' in sigPush ? sigPush.data : undefined;
    if (!sig || sig.length < 65 || !commitsToAllOutputs(sig[sig.length - 1])) continue;
    const prev = await fetchTx(provider, binToHex(input.outpointTransactionHash));
    if (typeof prev !== 'string' && binToHex(prev.outputs[input.outpointIndex]?.lockingBytecode ?? new Uint8Array()) === binToHex(lock.bytecode)) return null;
  }
  return 'the proof was not signed (SIGHASH_ALL) by a coin of the claimed address';
}

const MAX_INPUTS = 4, MAX_CLAIMS = 4, MAX_EVENTS = 8; // bound the chain lookups an attacker's event can cause
// base type ALL (0x01) with FORKID (0x40), never ANYONECANPAY (0x80); SIGHASH_UTXOS (0x20, CashScript's default) is fine
const commitsToAllOutputs = (t) => (t & 0x1f) === 0x01 && (t & 0x40) !== 0 && (t & 0x80) === 0;
/** A tx from the network, checked against its txid so a lying server can't substitute one. */
async function fetchTx(provider, txid) {
  let raw;
  try { raw = hexToBin(await provider.getRawTransaction(txid)); } catch { return 'the proof transaction is not on this network'; }
  if (binToHex(sha256.hash(sha256.hash(raw)).reverse()) !== txid) return 'the server returned a different transaction';
  const tx = decodeTransaction(raw);
  return typeof tx === 'string' ? 'the proof transaction does not decode' : tx;
}

/** Check a link event end to end.
 *  @returns {Promise<{ ok: boolean, reason?: string, address?: string, nostrPubkey?: string, txid?: string, created_at?: number }>} */
export async function verifyLink(event, provider) {
  const fail = (reason) => ({ ok: false, reason, nostrPubkey: event?.pubkey });
  if (!event || event.kind !== LINK_KIND || !verifyFresh(event)) return fail('the Nostr signature does not verify');
  if (event.created_at > Date.now() / 1000 + 600) return fail('the event is dated in the future');
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === LINK_D)) return fail('not a Jelajah ID event');
  const i = event.tags.find((t) => t[0] === 'i' && t[1]?.startsWith('bch:'));
  if (!i || !/^[0-9a-f]{64}$/.test(i[2] ?? '')) return fail('no BCH address or proof txid in the event');
  const address = i[1].slice(4), txid = i[2];
  if (event.content !== statement({ address, nostrPubkey: event.pubkey })) return fail('the signed statement does not match the address and key');
  const problem = await checkProofTx(provider, txid, address, event.pubkey, event.content);
  if (problem) return fail(problem);
  return { ok: true, address, nostrPubkey: event.pubkey, txid, created_at: event.created_at };
}

/** Check a NIP-39 list (kind 10011) for an on-chain `bch:` claim; `address` picks one when it holds several.
 *  @returns {Promise<{ ok: boolean, reason?: string, address?: string, nostrPubkey?: string, txid?: string, created_at?: number, nip39?: boolean }>} */
export async function verifyNip39(event, provider, address) {
  const fail = (reason) => ({ ok: false, reason, nostrPubkey: event?.pubkey });
  if (!event || event.kind !== NIP39_KIND || !verifyFresh(event)) return fail('the Nostr signature does not verify');
  if (event.created_at > Date.now() / 1000 + 600) return fail('the event is dated in the future');
  const claims = event.tags.filter((t) => t[0] === 'i' && /^bch(test)?:q[0-9a-z]+$/.test(t[1] ?? '') && /^tx:[0-9a-f]{64}$/.test(t[2] ?? ''))
    .filter((t) => !address || t[1] === nip39Id(address)).slice(0, MAX_CLAIMS);
  let last = fail('no on-chain bch claim in the NIP-39 list');
  for (const [, id, proof] of claims) {
    const [platform, payload] = id.split(':');
    const addr = `${platform === 'bch' ? 'bitcoincash' : 'bchtest'}:${payload}`;
    const problem = await checkProofTx(provider, proof.slice(3), addr, event.pubkey);
    if (!problem) return { ok: true, address: addr, nostrPubkey: event.pubkey, txid: proof.slice(3), created_at: event.created_at, nip39: true };
    last = fail(problem);
  }
  return last;
}

/** Find link events by Nostr key (hex) or by BCH address; newest first. pool: a nostr-tools SimplePool.
 *  @param {any} pool @param {{ nostrPubkey?: string, address?: string }} who @param {string[]} [relays] */
export async function findLinks(pool, { nostrPubkey, address }, relays = RELAYS) {
  const filter = { kinds: [LINK_KIND], '#d': [LINK_D], ...(nostrPubkey ? { authors: [nostrPubkey] } : {}), ...(address ? { '#i': [`bch:${address}`] } : {}) };
  const events = await pool.querySync(relays, filter, { maxWait: 4000 });
  return events.sort((a, b) => b.created_at - a.created_at);
}

/** The newest link that actually verifies: anyone can publish an event tagged with your address, so an unverified
 *  (or future-dated) event must never shadow the real one. */
/** @returns {Promise<{ ok: boolean, reason?: string, address?: string, nostrPubkey?: string, txid?: string, created_at?: number, nip39?: boolean }>} */
export async function findVerified(pool, who, provider, relays = RELAYS) {
  let last = null;
  const nip39 = await pool.querySync(relays, { kinds: [NIP39_KIND], ...(who.nostrPubkey ? { authors: [who.nostrPubkey] } : {}), ...(who.address ? { '#i': [nip39Id(who.address)] } : {}) }, { maxWait: 4000 });
  const events = [...await findLinks(pool, who, relays), ...nip39].sort((a, b) => b.created_at - a.created_at).slice(0, MAX_EVENTS);
  for (const ev of events) {
    const r = ev.kind === NIP39_KIND ? await verifyNip39(ev, provider, who.address) : await verifyLink(ev, provider);
    if (r.ok && (!who.nostrPubkey || r.nostrPubkey === who.nostrPubkey) && (!who.address || r.address === who.address)) return r;
    last = r;
  }
  return last ?? { ok: false, reason: 'no Jelajah ID found on public relays' };
}

/** Login: the app hands out a random challenge; the user signs a one-off event with their Nostr key; the app checks
 *  the signature and freshness, then resolves the verified BCH address from the published link. */
export const loginChallenge = () => binToHex(crypto.getRandomValues(new Uint8Array(16)));
export const loginEvent = (challenge, origin) => ({ kind: LOGIN_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['challenge', challenge], ['u', origin]], content: 'Log in to a Jelajah ID app' });
// ponytail: the caller must issue each challenge once and forget it after use (a verifier keeps that state).
export function checkLogin(event, challenge, origin, maxAge = 300) {
  if (!event || event.kind !== LOGIN_KIND || !verifyFresh(event)) return 'bad signature';
  if (!event.tags.some((t) => t[0] === 'challenge' && t[1] === challenge)) return 'wrong challenge';
  const u = event.tags.filter((t) => t[0] === 'u');
  if (u.length !== 1 || u[0][1] !== origin) return 'answer was made for another site';
  if (Math.abs(Date.now() / 1000 - event.created_at) > maxAge) return 'stale answer';
  return null;
}

export const plainAddress = (lockOrAddress, prefix) =>
  typeof lockOrAddress === 'string' ? lockOrAddress : lockingBytecodeToCashAddress({ bytecode: lockOrAddress, prefix }).address;
