// Jelajah ID verification, offline: a real mainnet link (fixture) must verify, and every tampering must be refused.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { verifyLink, statement, checkLogin, loginEvent } from '../src/lib/identity.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/identity.json', import.meta.url)));
const provider = { getRawTransaction: async (id) => { if (!fx.txs[id]) throw new Error('unknown tx'); return fx.txs[id]; } };
const ok = await verifyLink(fx.event, provider);
assert.equal(ok.ok, true, ok.reason);
console.log('PASS the published mainnet link verifies:', ok.address);

const refused = async (name, ev, why) => {
  const r = await verifyLink(ev, provider);
  assert.equal(r.ok, false, `${name} was accepted`);
  assert.match(r.reason, why);
  console.log('PASS (refused)', name, '->', r.reason);
};
const other = 'bitcoincash:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2';
const attacker = generateSecretKey();

await refused('the event edited to claim another address', { ...fx.event, tags: fx.event.tags.map((t) => (t[0] === 'i' ? ['i', `bch:${other}`, t[2]] : t)) }, /signature/);
await refused("someone else's Nostr key re-signing the same proof",
  finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at, tags: fx.event.tags, content: fx.event.content }, attacker), /statement/);
const iTag = fx.event.tags.find((t) => t[0] === 'i');
await refused('an attacker claiming the address with their own key and statement, pointing at this proof',
  finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at, tags: fx.event.tags,
    content: statement({ address: iTag[1].slice(4), nostrPubkey: (await import('nostr-tools/pure')).getPublicKey(attacker) }) }, attacker), /does not commit/);
await refused('a claim for another address reusing this proof tx',
  finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at, tags: [['d', 'jelajah-bch-link'], ['i', `bch:${other}`, iTag[2]]],
    content: statement({ address: other, nostrPubkey: (await import('nostr-tools/pure')).getPublicKey(attacker) }) }, attacker), /does not commit/);
{ // a well-formed claim signed by its own key, but whose proof tx doesn't exist
  const { getPublicKey } = await import('nostr-tools/pure');
  const address = iTag[1].slice(4);
  await refused('a proof txid that is not on chain',
    finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at, tags: [['d', 'jelajah-bch-link'], ['i', `bch:${address}`, '00'.repeat(32)]],
      content: statement({ address, nostrPubkey: getPublicKey(attacker) }) }, attacker), /not on this network/);
}

const sk = generateSecretKey();
const ans = finalizeEvent(loginEvent('ab'.repeat(16), 'https://example.org'), sk);
const O = 'https://example.org';
assert.equal(checkLogin(ans, 'ab'.repeat(16), O), null);
assert.equal(checkLogin(ans, 'cd'.repeat(16), O), 'wrong challenge');
assert.equal(checkLogin(ans, 'ab'.repeat(16), 'https://evil.example'), 'answer was made for another site');
assert.equal(checkLogin({ ...ans, content: 'tampered' }, 'ab'.repeat(16), O), 'bad signature');
console.log('PASS login: the right challenge passes; a wrong challenge, another site, or a tampered answer is refused');

{ // a junk event tagged with the victim's address, newer than the real link, must not shadow it
  const { findVerified } = await import('../src/lib/identity.js');
  const junk = finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at + 100, tags: fx.event.tags, content: 'junk' }, attacker);
  const future = finalizeEvent({ kind: fx.event.kind, created_at: Math.floor(Date.now() / 1000) + 86400, tags: fx.event.tags, content: fx.event.content }, attacker);
  const pool = { querySync: async () => [future, junk, fx.event] };
  const r = await findVerified(pool, { address: iTag[1].slice(4) }, provider);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.nostrPubkey, fx.event.pubkey);
  console.log('PASS a newer junk or future-dated event cannot shadow the real link');
}

{ // v2: the same link as a standard NIP-39 claim (kind 10011) with an on-chain proof, as TwinKey's verifier reads it
  const { verifyNip39, nip39Event } = await import('../src/lib/identity.js');
  const { getPublicKey } = await import('nostr-tools/pure');
  const r = await verifyNip39(fx.nip39, provider);
  assert.equal(r.ok, true, r.reason);
  console.log('PASS the published NIP-39 claim (kind 10011) verifies:', r.address);
  const claim = fx.nip39.tags.find((t) => t[0] === 'i' && t[1].startsWith('bch:'));
  const resign = (tags) => finalizeEvent({ kind: 10011, created_at: fx.nip39.created_at, tags, content: '' }, attacker);
  assert.equal((await verifyNip39(resign([claim]), provider)).ok, false); // another key reusing the proof
  assert.equal((await verifyNip39(resign([['i', 'bch:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2', claim[2]]]), provider)).ok, false);
  assert.equal((await verifyNip39({ ...fx.nip39, tags: [['i', 'bch:qr6m7j9njldwwzlg9v7v53unlr4jkmx6eylep8ekg2', claim[2]]] }, provider)).ok, false);
  console.log('PASS (refused) NIP-39: another key reusing the proof, a proof for another address, an edited list');
  const merged = nip39Event({ created_at: 10, tags: [['i', 'github:someone', 'gist'], ['i', claim[1], 'tx:' + '00'.repeat(32)]] }, { address: r.address, txid: r.txid });
  assert.deepEqual(merged.tags, [['i', 'github:someone', 'gist'], ['i', claim[1], `tx:${r.txid}`]]);
  assert.equal(getPublicKey(attacker).length, 64);
  console.log('PASS publishing keeps the key’s other NIP-39 claims and replaces only this address');
}

{ // a coin signed SIGHASH_SINGLE|ANYONECANPAY (e.g. in a coinjoin) doesn't commit to the OP_RETURN, so it proves nothing
  const { verifyLink } = await import('../src/lib/identity.js');
  const { decodeTransaction, encodeTransaction, decodeAuthenticationInstructions, encodeAuthenticationInstructions, hexToBin: h2b, binToHex: b2h, sha256: sh } = await import('@bitauth/libauth');
  const iT = fx.event.tags.find((t) => t[0] === 'i');
  const tx = decodeTransaction(h2b(fx.txs[iT[2]]));
  const ins = decodeAuthenticationInstructions(tx.inputs[0].unlockingBytecode);
  ins[0] = { ...ins[0], data: Uint8Array.from([...ins[0].data.slice(0, -1), 0xc3]) }; // SINGLE|FORKID|ANYONECANPAY
  tx.inputs[0] = { ...tx.inputs[0], unlockingBytecode: encodeAuthenticationInstructions(ins) };
  const raw = encodeTransaction(tx), id = b2h(sh.hash(sh.hash(raw)).reverse());
  const txs = { ...fx.txs, [id]: b2h(raw) };
  const p2 = { getRawTransaction: async (x) => { if (!txs[x]) throw new Error('unknown'); return txs[x]; } };
  const ev = finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at, tags: fx.event.tags.map((t) => (t[0] === 'i' ? [t[0], t[1], id] : t)), content: statement({ address: iT[1].slice(4), nostrPubkey: (await import('nostr-tools/pure')).getPublicKey(attacker) }) }, attacker);
  assert.equal((await verifyLink(ev, p2)).ok, false);
  const liar = { getRawTransaction: async (x) => fx.txs[Object.keys(fx.txs).find((k) => k !== x)] }; // a server answering with another tx
  assert.match((await verifyLink(fx.event, liar)).reason, /different transaction/);
  console.log('PASS (refused) a proof whose coin was signed ANYONECANPAY, and a server substituting another tx');
}

{ // twenty newer, validly signed junk events tagged with the victim's address can't push the real link out
  const { findVerified } = await import('../src/lib/identity.js');
  const { generateSecretKey: gen } = await import('nostr-tools/pure');
  const junk = Array.from({ length: 20 }, (_, i) => finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at + 100 + i, tags: fx.event.tags, content: fx.event.content }, gen()));
  const pool = { querySync: async () => [...junk, fx.event] };
  const r = await findVerified(pool, { address: iTag[1].slice(4) }, provider);
  assert.equal(r.ok, true, r.reason);
  console.log('PASS 20 newer junk events from 20 keys cannot push the real link out');
}

{ // 30 self-consistent forgeries (each key claims the victim's address and points at the real proof) still lose
  const { findVerified, statement: st } = await import('../src/lib/identity.js');
  const { generateSecretKey: gen, getPublicKey: gpk } = await import('nostr-tools/pure');
  let fetches = 0;
  const counting = { getRawTransaction: async (id) => { fetches++; return provider.getRawTransaction(id); } };
  const addr = iTag[1].slice(4);
  const forged = Array.from({ length: 30 }, (_, i) => { const k = gen();
    return finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at + 100 + i, tags: fx.event.tags, content: st({ address: addr, nostrPubkey: gpk(k) }) }, k); });
  const r = await findVerified({ querySync: async () => [...forged, fx.event] }, { address: addr }, counting);
  assert.equal(r.ok, true, r.reason);
  assert.ok(fetches <= 4, `${fetches} chain lookups`);
  console.log(`PASS 30 self-consistent forgeries pointing at the real proof still lose (${fetches} chain lookups in all)`);
}

{ // forged events pointing at non-existent txs cost one lookup each, bounded per search; the real link still wins
  const { findVerified, statement: st } = await import('../src/lib/identity.js');
  const { generateSecretKey: gen, getPublicKey: gpk } = await import('nostr-tools/pure');
  let lookups = 0;
  const counting = { getRawTransaction: async (id) => { lookups++; return provider.getRawTransaction(id); } };
  const addr = iTag[1].slice(4);
  const forged = Array.from({ length: 40 }, (_, i) => { const k = gen();
    return finalizeEvent({ kind: fx.event.kind, created_at: fx.event.created_at + 100 + i, tags: [['d', 'jelajah-bch-link'], ['i', `bch:${addr}`, i.toString(16).padStart(64, '0')]], content: st({ address: addr, nostrPubkey: gpk(k) }) }, k); });
  const r = await findVerified({ querySync: async () => [...forged, fx.event] }, { address: addr }, counting);
  assert.equal(r.ok, true, r.reason);
  assert.ok(lookups <= 80, `${lookups} lookups`);
  console.log(`PASS 40 forgeries with fake txids still lose (${lookups} lookups, budget 80)`);
}

{ // rally discovery: signed, right network, well-formed payload, newest per (author, rally); everything else dropped
  const { findRallies, rallyEvent } = await import('../src/lib/identity.js');
  const k = generateSecretKey();
  const r = 'A'.repeat(40);
  const ev = (over, key = k) => finalizeEvent({ ...rallyEvent({ name: 'Jelajah Test', network: 'chipnet', category: 'ab'.repeat(32), r }), ...over }, key);
  const old = ev({ created_at: 1000 });
  const newer = ev({ created_at: 2000, content: 'Renamed' });
  const tampered = { ...ev({ created_at: 3000 }), content: 'Hijacked' };
  const otherNet = ev({ tags: rallyEvent({ name: 'x', network: 'mainnet', category: 'cd'.repeat(32), r }).tags });
  const badPayload = ev({ tags: rallyEvent({ name: 'x', network: 'chipnet', category: 'ef'.repeat(32), r: 'javascript:alert(1)' }).tags });
  const list = await findRallies({ querySync: async () => [old, newer, tampered, otherNet, badPayload] }, 'chipnet');
  assert.deepEqual(list.map((x) => x.name), ['Renamed']);
  console.log('PASS rally discovery keeps only the newest signed, well-formed listing for this network');
}
