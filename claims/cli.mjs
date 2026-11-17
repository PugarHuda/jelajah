// Operator + claimer CLI for pull-based Merkle claims (FoldingCash bounty demo).
//   node claims/cli.mjs setup    --network chipnet     3 geneses (proposal authority, keeper NFT, test FLDCH), fund the pool
//   node claims/cli.mjs claim    --network chipnet --who demo1
//   node claims/cli.mjs propose  --network chipnet --distro claims/data/fldch-distro-2026-11.json
//   node claims/cli.mjs activate --network chipnet     after `delay` blocks
//   node claims/cli.mjs sync     --network chipnet     rebuild claimed totals from the chain (what a watcher does)
// State (distribution + claimed totals + categories) lives in claims/state.<network>.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
  secp256k1, hash160, binToHex, hexToBin, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
  decodePrivateKeyWif, generatePrivateKey, decodeTransaction, decodeAuthenticationInstructions, vmNumberToBigInt,
} from '@bitauth/libauth';
import { claimContracts, buildClaim, buildPropose, buildActivate, DUST } from './lib/tx.js';
import { buildTrees, rootsCommitment, epochOf } from './lib/merkle.js';
import { addEpoch } from './lib/distro.js';

const { positionals: [cmd], values: opt } = parseArgs({
  allowPositionals: true,
  options: { network: { type: 'string', default: 'chipnet' }, who: { type: 'string' }, distro: { type: 'string' } },
});
const network = opt.network;
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = network === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';
const here = (p) => new URL(p, import.meta.url);
const stateFile = here(`state.${network}.json`);
const provider = new ElectrumNetworkProvider(network);
const DEPTH = 16, DELAY = 2, LEAVES = 300;

const wallet = (priv) => {
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  const lock = encodeLockingBytecodeP2pkh(pkh);
  const address = lockingBytecodeToCashAddress({ bytecode: lock, prefix }).address;
  const sig = new SignatureTemplate(priv);
  const coins = async () => (await provider.getUtxos(address)).map((utxo) => ({ utxo, unlocker: sig.unlockP2PKH() }));
  return { pub, pkh: binToHex(pkh), lock, address, sig, coins };
};
const operator = wallet(decodePrivateKeyWif(JSON.parse(readFileSync(here(`../scripts/.organizer.${network}.json`))).wif).privateKey);
const demoFile = here(`.demo.${network}.json`); // throwaway claimer keys, gitignored
if (!existsSync(demoFile)) writeFileSync(demoFile, JSON.stringify({ demo1: binToHex(generatePrivateKey()), demo2: binToHex(generatePrivateKey()) }));
const demo = Object.fromEntries(Object.entries(JSON.parse(readFileSync(demoFile))).map(([k, v]) => [k, wallet(hexToBin(v))]));

const load = () => JSON.parse(readFileSync(stateFile));
const save = (s) => writeFileSync(stateFile, JSON.stringify(s, null, 2) + '\n');
const send = async (label, tb) => { const { txid } = await tb.send(); console.log(label.padEnd(22), explorer + txid); return txid; };
const bchCoins = async () => (await operator.coins()).filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis));

if (cmd === 'setup') {
  // distribution: real FoldingCash October 2026 + two demo claimers + filler folders up to LEAVES
  const oct = JSON.parse(readFileSync(here('data/fldch-distro-2026-10.json')));
  const dist = addEpoch(undefined, oct, DEPTH);
  for (const [i, d] of Object.values(demo).entries()) dist.entries.push({ index: dist.entries.length, pkh: d.pkh, cumulative: String((i + 1) * 250_000_000) });
  while (dist.entries.length < LEAVES) dist.entries.push({ index: dist.entries.length, pkh: binToHex(hash160(new TextEncoder().encode(`filler-${dist.entries.length}`))), cumulative: '100000' });
  delete dist.skipped;
  const total = dist.entries.reduce((s, e) => s + BigInt(e.cumulative), 0n);

  // a genesis spends a vout-0 outpoint; each genesis leaves its change at vout 0 for the next one
  let [c] = await bchCoins();
  if (!c || c.utxo.satoshis < 30_000n) throw new Error(`fund ${operator.address} with 30000+ sats`);
  if (c.utxo.vout !== 0) {
    const txid = await send('prepare vout-0', new TransactionBuilder({ provider }).addInput(c.utxo, c.unlocker).addOutput({ to: operator.lock, amount: c.utxo.satoshis - 1000n }));
    c = { utxo: { txid, vout: 0, satoshis: c.utxo.satoshis - 1000n, lockingBytecode: binToHex(operator.lock) }, unlocker: operator.sig.unlockP2PKH() };
  }
  const genesis = async (label, outputs) => {
    const category = c.utxo.txid;
    const tb = new TransactionBuilder({ provider }).addInput(c.utxo, c.unlocker);
    const spent = outputs(category).reduce((s, o) => s + o.amount, 0n);
    tb.addOutput({ to: operator.lock, amount: c.utxo.satoshis - spent - 1500n });
    outputs(category).forEach((o) => tb.addOutput(o));
    const txid = await send(label, tb);
    c = { utxo: { txid, vout: 0, satoshis: c.utxo.satoshis - spent - 1500n, lockingBytecode: binToHex(operator.lock) }, unlocker: operator.sig.unlockP2PKH() };
    return category;
  };
  // order matters: the pool is parameterised with the reward + keeper categories, the keeper with the pool
  const proposalCategory = await genesis('genesis proposal auth', (cat) => [{ to: operator.lock, amount: DUST, token: { category: cat, amount: 0n, nft: { capability: 'minting', commitment: '' } } }]);
  const rewardCategory = await genesis('genesis test FLDCH', (cat) => [{ to: operator.lock, amount: DUST, token: { category: cat, amount: total * 10n } }]);
  const keeperCategory = c.utxo.txid;
  const cfg = { keeperCategory, proposalCategory, rewardCategory, depth: DEPTH, delay: DELAY, operatorPub: binToHex(operator.pub) };
  const { pool, keeper } = claimContracts(cfg, provider);
  const trees = buildTrees(DEPTH, dist.entries);
  await genesis('genesis keeper NFT', (cat) => [{ to: keeper.tokenAddress, amount: DUST, token: { category: cat, amount: 0n, nft: { capability: 'mutable', commitment: rootsCommitment(trees.earned.root(), trees.claimed.root(), 0) } } }]);

  // move the reward tokens into the pool, fund the two demo claimers
  const ft = (await operator.coins()).find((x) => x.utxo.token?.category === rewardCategory);
  const tb = new TransactionBuilder({ provider }).addInput(ft.utxo, ft.unlocker).addInput(c.utxo, c.unlocker)
    .addOutput({ to: pool.tokenAddress, amount: DUST, token: ft.utxo.token });
  for (const d of Object.values(demo)) tb.addOutput({ to: d.lock, amount: 10_000n });
  tb.addOutput({ to: operator.lock, amount: c.utxo.satoshis + ft.utxo.satoshis - DUST - 20_000n - 1500n });
  await send('fund pool + claimers', tb);
  const tokenCategory = rewardCategory;
  save({ network, cfg, tokenCategory, dist, claimed: {}, pool: pool.tokenAddress, keeper: keeper.tokenAddress });
  console.log(`pool funded with ${total * 10n} units for ${dist.entries.length} leaves (depth ${DEPTH})`);
} else if (cmd === 'claim') {
  const s = load();
  const who = demo[opt.who];
  if (!who) throw new Error(`--who must be one of ${Object.keys(demo)}`);
  const { pool, keeper } = claimContracts(s.cfg, provider);
  const r = await buildClaim({ pool, keeper, dist: s.dist, claimed: s.claimed, pkh: who.pkh, coins: await who.coins() });
  const before = r.builder.build().length / 2;
  await send(`claim ${r.payout} (${before} B)`, r.builder);
  save({ ...s, claimed: { ...s.claimed, [r.index]: s.dist.entries[r.index].cumulative } });
} else if (cmd === 'propose') {
  const s = load();
  const next = addEpoch(s.dist, JSON.parse(readFileSync(opt.distro)), s.cfg.depth);
  delete next.skipped;
  const root = buildTrees(next.depth, next.entries).earned.root();
  const { proposal, keeper } = claimContracts(s.cfg, provider);
  const [k] = await keeper.getUtxos();
  const epoch = epochOf(k.token.nft.commitment) + 1;
  const all = await operator.coins();
  const authority = all.find((c) => c.utxo.token?.category === s.cfg.proposalCategory);
  if (!authority) throw new Error('proposal authority NFT not found in the operator wallet');
  await send(`propose epoch ${epoch}`, buildPropose({ proposal, authority, root, epoch, coins: (await bchCoins()).slice(0, 1), changeLock: operator.lock }));
  save({ ...s, pending: next });
  console.log(`activate after ${s.cfg.delay} blocks`);
} else if (cmd === 'activate') {
  const s = load();
  const { keeper, proposal } = claimContracts(s.cfg, provider);
  const [coin] = await bchCoins();
  await send('activate root', await buildActivate({ keeper, proposal, delay: s.cfg.delay, coin, changeLock: operator.lock }));
  save({ ...s, dist: s.pending, pending: undefined });
} else if (cmd === 'sync') {
  // replay every claim the pool ever accepted: its unlocking data carries (index, cumulative)
  const s = load();
  const { pool, keeper } = claimContracts(s.cfg, provider);
  const history = await provider.performRequest('blockchain.address.get_history', pool.address);
  const claimed = {};
  for (const { tx_hash } of history) {
    const tx = decodeTransaction(hexToBin(await provider.getRawTransaction(tx_hash)));
    const input = tx.inputs.find((i) => binToHex(i.unlockingBytecode).endsWith(pool.bytecode));
    if (!input) continue;
    const pushes = decodeAuthenticationInstructions(input.unlockingBytecode).map((i) => i.data ?? (i.opcode >= 0x51 && i.opcode <= 0x60 ? Uint8Array.of(i.opcode - 0x50) : new Uint8Array()));
    if (pushes.length !== 8) continue; // claimedProof, earnedProof, index, before, cumulative, pkh, selector, redeem
    const num = (b) => (b.length ? vmNumberToBigInt(b) : 0n);
    const index = num(pushes[2]);
    const cumulative = num(pushes[4]);
    if (typeof index === 'bigint' && typeof cumulative === 'bigint') claimed[Number(index)] = cumulative.toString();
  }
  const [k] = await keeper.getUtxos();
  const trees = buildTrees(s.dist.depth, s.dist.entries, claimed);
  const ok = k.token.nft.commitment.slice(64, 128) === binToHex(trees.claimed.root());
  console.log(`claims replayed: ${Object.keys(claimed).length} · rebuilt claimed root ${ok ? 'MATCHES' : 'DOES NOT MATCH'} the keeper`);
  if (ok) save({ ...s, claimed });
} else {
  console.log('usage: node claims/cli.mjs setup|claim|propose|activate|sync --network chipnet');
}
process.exit(0);
