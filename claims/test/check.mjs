// Pull-based Merkle claims, end to end on CashScript's mock network (every tx is checked against the BCH VM).
// Real FoldingCash October 2026 distro (62 folders) + filler folders = 300 leaves in a depth-16 tree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { claimContracts, buildClaim, buildPropose, buildActivate, DUST } from '../lib/tx.js';
import { buildTrees, rootsCommitment } from '../lib/merkle.js';
import { addEpoch } from '../lib/distro.js';

const provider = new MockNetworkProvider();
const key = (n) => {
  const priv = new Uint8Array(32).fill(n);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { pub, pkh: binToHex(pkh), lock: encodeLockingBytecodeP2pkh(pkh), sig: new SignatureTemplate(priv) };
};
const operator = key(9), alice = key(1), bob = key(2), mallory = key(3);
const rand32 = () => binToHex(crypto.getRandomValues(new Uint8Array(32)));
const FLDCH = rand32(), KEEPER = rand32(), PROPOSAL = rand32();
const cfg = { keeperCategory: KEEPER, proposalCategory: PROPOSAL, depth: 16, delay: 6, operatorPub: binToHex(operator.pub) };
const { pool, keeper, proposal } = claimContracts(cfg, provider);

// epoch 1: real October distro + alice/bob + filler up to 300 leaves
const oct = JSON.parse(readFileSync(new URL('../data/fldch-distro-2026-10.json', import.meta.url)));
let dist = addEpoch(undefined, oct);
dist.entries.push({ index: dist.entries.length, pkh: alice.pkh, cumulative: '500000000' }, { index: dist.entries.length + 1, pkh: bob.pkh, cumulative: '300000000' });
while (dist.entries.length < 300) dist.entries.push({ index: dist.entries.length, pkh: binToHex(hash160(new Uint8Array([dist.entries.length >> 8, dist.entries.length & 255]))), cumulative: '1000' });
assert.equal(dist.entries.length, 300);
assert.equal(dist.skipped.length, 0, 'every October address mapped to a pkh');
let claimed = {};
const total = dist.entries.reduce((s, e) => s + BigInt(e.cumulative), 0n);

// setup: keeper NFT (no minting authority ever), pool funded with every folder's total
const roots = (d, c) => { const t = buildTrees(d.depth, d.entries, c); return rootsCommitment(t.earned.root(), t.claimed.root()); };
provider.addUtxo(keeper.address, randomUtxo({ satoshis: DUST, token: { category: KEEPER, amount: 0n, nft: { capability: 'mutable', commitment: roots(dist, claimed) } } }));
provider.addUtxo(pool.address, randomUtxo({ satoshis: DUST, token: { category: FLDCH, amount: total * 2n } }));
const authority = { utxo: provider.addUtxo(binToHex(operator.lock), randomUtxo({ satoshis: DUST, token: { category: PROPOSAL, amount: 0n, nft: { capability: 'minting', commitment: '' } } })), unlocker: operator.sig.unlockP2PKH() };

const coins = (who) => [{ utxo: provider.addUtxo(binToHex(who.lock), randomUtxo({ satoshis: 20_000n })), unlocker: who.sig.unlockP2PKH() }];
const tokensOf = async (who) => (await provider.getUtxosForLockingBytecode(binToHex(who.lock))).filter((u) => u.token?.category === FLDCH).reduce((s, u) => s + u.token.amount, 0n);
const fails = async (name, fn) => {
  const err = await fn().then(() => null, (e) => e);
  assert.ok(err, `${name}: was accepted`);
  const line = String(err.message).split('\n').find((l) => /require statement failed|Failing/i.test(l));
  assert.ok(line, `${name}: rejected for an unexpected reason: ${err.message.slice(0, 300)}`);
  console.log('PASS (rejected)', name, '->', line.match(/\w+\.cash:\d+/)?.[0] ?? line.trim().slice(0, 80));
};
const claim = async (who, opts = {}) => {
  const r = await buildClaim({ pool, keeper, dist, claimed, pkh: who.pkh, coins: coins(who), ...opts });
  await r.builder.send();
  claimed = { ...claimed, [r.index]: dist.entries[r.index].cumulative };
  return r;
};

// --- epoch 1
let r = await claim(alice);
assert.equal(await tokensOf(alice), 500000000n);
console.log(`PASS alice claimed ${r.payout} units with a ${dist.depth}-deep proof over ${dist.entries.length} leaves`);
await claim(bob);
assert.equal(await tokensOf(bob), 300000000n);
console.log('PASS bob claimed after alice (claimed root moved on chain, his proof built against it)');

// replay: alice pretends she never claimed (the "hide your receipt" attack): claimedBefore = 0,
// with a claimed-tree proof built as if her leaf were still empty. Built by hand so the contract itself must refuse.
await fails('double claim by hiding the previous claim', async () => {
  const me = dist.entries.find((e) => e.pkh === alice.pkh);
  const lie = buildTrees(dist.depth, dist.entries, { ...claimed, [me.index]: 0 });
  const t = buildTrees(dist.depth, dist.entries, claimed);
  const [p] = await pool.getUtxos(); const [k] = await keeper.getUtxos();
  const c = coins(alice)[0];
  return new TransactionBuilder({ provider })
    .addInput(p, pool.unlock.claim(alice.pkh, BigInt(me.cumulative), 0n, BigInt(me.index), t.earned.proof(me.index), lie.claimed.proof(me.index)))
    .addInput(k, keeper.unlock.claim())
    .addInput(c.utxo, c.unlocker)
    .addOutput({ to: pool.tokenAddress, amount: p.satoshis, token: { ...p.token, amount: p.token.amount - BigInt(me.cumulative) } })
    .addOutput({ to: keeper.tokenAddress, amount: k.satoshis, token: k.token })
    .addOutput({ to: alice.lock, amount: DUST, token: { category: FLDCH, amount: BigInt(me.cumulative) } })
    .send();
});

await fails('claim with a forged amount (not in the earned root)', async () => {
  const forged = { ...dist, entries: dist.entries.concat([{ index: 300, pkh: mallory.pkh, cumulative: '999999999' }]) };
  const t = buildTrees(forged.depth, forged.entries, claimed);
  const [p] = await pool.getUtxos(); const [k] = await keeper.getUtxos();
  const c = coins(mallory)[0];
  return new TransactionBuilder({ provider })
    .addInput(p, pool.unlock.claim(mallory.pkh, 999999999n, 0n, 300n, t.earned.proof(300), t.claimed.proof(300)))
    .addInput(k, keeper.unlock.claim())
    .addInput(c.utxo, c.unlocker)
    .addOutput({ to: pool.tokenAddress, amount: p.satoshis, token: { ...p.token, amount: p.token.amount - 999999999n } })
    .addOutput({ to: keeper.tokenAddress, amount: k.satoshis, token: k.token })
    .addOutput({ to: mallory.lock, amount: DUST, token: { category: FLDCH, amount: 999999999n } })
    .send();
});

await fails('payout to an address other than the leaf owner', async () => {
  const t = buildTrees(dist.depth, dist.entries, claimed);
  // carol is in the tree but unclaimed; mallory submits carol's claim and pays herself
  const carol = dist.entries[0];
  const after = buildTrees(dist.depth, [], { ...claimed, [carol.index]: carol.cumulative }).claimed;
  const [p] = await pool.getUtxos(); const [k] = await keeper.getUtxos();
  const c = coins(mallory)[0];
  return new TransactionBuilder({ provider })
    .addInput(p, pool.unlock.claim(carol.pkh, BigInt(carol.cumulative), 0n, BigInt(carol.index), t.earned.proof(carol.index), t.claimed.proof(carol.index)))
    .addInput(k, keeper.unlock.claim())
    .addInput(c.utxo, c.unlocker)
    .addOutput({ to: pool.tokenAddress, amount: p.satoshis, token: { ...p.token, amount: p.token.amount - BigInt(carol.cumulative) } })
    .addOutput({ to: keeper.tokenAddress, amount: k.satoshis, token: { ...k.token, nft: { ...k.token.nft, commitment: rootsCommitment(t.earned.root(), after.root()) } } })
    .addOutput({ to: mallory.lock, amount: DUST, token: { category: FLDCH, amount: BigInt(carol.cumulative) } })
    .send();
});

// --- epoch 2: alice earns more; root goes through a proposal and its delay
const next = { ...dist, entries: dist.entries.map((e) => (e.pkh === alice.pkh ? { ...e, cumulative: '800000000' } : e)) };
const newRoot = buildTrees(next.depth, next.entries).earned.root();
await buildPropose({ proposal, authority, root: newRoot, coins: coins(operator), changeLock: operator.lock }).send();
await fails('activating a proposal before its delay', async () => {
  const b = await buildActivate({ keeper, proposal, delay: cfg.delay - 1, coin: coins(operator)[0], changeLock: operator.lock });
  return b.send();
});
await (await buildActivate({ keeper, proposal, delay: cfg.delay, coin: coins(operator)[0], changeLock: operator.lock })).send();
dist = next;
console.log('PASS new earned root activated after the delay; claimed totals carried over');

r = await claim(alice);
assert.equal(r.payout, 300000000n);
assert.equal(await tokensOf(alice), 800000000n);
console.log('PASS alice claimed only the difference (300000000) after the new root');

await fails('fake keeper with a different category', async () => {
  const FAKE = rand32();
  const t = buildTrees(dist.depth, dist.entries, claimed);
  const forgedRoots = rootsCommitment(t.earned.root(), t.claimed.root());
  const fake = provider.addUtxo(binToHex(mallory.lock), randomUtxo({ satoshis: DUST, token: { category: FAKE, amount: 0n, nft: { capability: 'mutable', commitment: forgedRoots } } }));
  const bobE = dist.entries.find((e) => e.pkh === bob.pkh);
  const [p] = await pool.getUtxos();
  return new TransactionBuilder({ provider })
    .addInput(p, pool.unlock.claim(bob.pkh, BigInt(bobE.cumulative), 0n, BigInt(bobE.index), t.earned.proof(bobE.index), t.claimed.proof(bobE.index)))
    .addInput(fake, mallory.sig.unlockP2PKH())
    .addInput(...((c) => [c.utxo, c.unlocker])(coins(mallory)[0]))
    .addOutput({ to: pool.tokenAddress, amount: p.satoshis, token: { ...p.token, amount: p.token.amount - BigInt(bobE.cumulative) } })
    .addOutput({ to: mallory.lock, amount: DUST, token: fake.token })
    .addOutput({ to: bob.lock, amount: DUST, token: { category: FLDCH, amount: BigInt(bobE.cumulative) } })
    .send();
});

const [k] = await keeper.getUtxos();
assert.equal(k.token.nft.commitment, roots(dist, claimed));
console.log('PASS on-chain roots equal the locally rebuilt trees');
