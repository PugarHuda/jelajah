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
assert.equal(checkLogin(ans, 'ab'.repeat(16)), null);
assert.equal(checkLogin(ans, 'cd'.repeat(16)), 'wrong challenge');
assert.equal(checkLogin({ ...ans, content: 'tampered' }, 'ab'.repeat(16)), 'bad signature');
console.log('PASS login: the right challenge passes; a wrong challenge or a tampered answer is refused');
