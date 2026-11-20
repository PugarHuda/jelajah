// Organizer CLI: create a key, then deploy a rally (genesis + minters + vault) on chipnet or mainnet.
//   node scripts/rally.mjs address  --network chipnet          print the organizer funding address
//   node scripts/rally.mjs deploy   --network chipnet [--registry https://host/bcmr.json]
//   node scripts/rally.mjs reclaim  --network chipnet [--rally file]   take back the pool after the rally ends
// Merchants are paid at --merchant-address (default: the organizer) — set real stall addresses for a real rally.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { rallyContracts, checkRallyConfig, genesisNeed, planRally, buildGenesis, buildReclaim } from '../src/lib/tx.js'; // one place that knows which contract version a rally uses
import {
  secp256k1, hash160, binToHex, hexToBin, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
  encodePrivateKeyWif, decodePrivateKeyWif, cashAddressToLockingBytecode, generatePrivateKey,
} from '@bitauth/libauth';

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root)));
const write = (p, v) => writeFileSync(new URL(p, root), JSON.stringify(v, null, 2) + '\n');

const { positionals: [cmd], values: opt } = parseArgs({
  allowPositionals: true,
  options: { network: { type: 'string', default: 'chipnet' }, registry: { type: 'string' }, rally: { type: 'string' }, config: { type: 'string' }, out: { type: 'string' }, 'merchant-address': { type: 'string' } },
});
const network = opt.network;
if (!['chipnet', 'mainnet'].includes(network)) throw new Error('--network must be chipnet or mainnet');
const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const DUST = 1000n;

// organizer key lives next to this script, never committed (.gitignore)
const keyFile = new URL(`scripts/.organizer.${network}.json`, root);
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify({ wif: encodePrivateKeyWif(generatePrivateKey(), network === 'mainnet' ? 'mainnet' : 'testnet') }));
const decoded = decodePrivateKeyWif(JSON.parse(readFileSync(keyFile)).wif);
if (typeof decoded === 'string') throw new Error(decoded);
const pub = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
const organizerLock = encodeLockingBytecodeP2pkh(hash160(pub));
const addr = (lock, tokenSupport = false) => lockingBytecodeToCashAddress({ bytecode: lock, prefix, tokenSupport }).address;
const signer = new SignatureTemplate(decoded.privateKey);
const provider = new ElectrumNetworkProvider(network);

if (cmd === 'address') {
  console.log(`organizer (${network}): ${addr(organizerLock, true)}`);
  const coins = await provider.getUtxos(addr(organizerLock));
  console.log(`balance: ${coins.reduce((s, u) => s + u.satoshis, 0n)} sats in ${coins.length} coins`);
  process.exit(0);
}

if (cmd === 'reclaim') {
  const rally = read(opt.rally ?? `src/rally.${network}.json`); // --rally scripts/rally.mainnet-v1.json for a retired rally
  const { vault } = rallyContracts(rally, provider);
  const { builder } = await buildReclaim({ rally, provider, vault, signer, to: organizerLock }); // shared with the app's #/reclaim
  const { txid } = await builder.send();
  console.log('reclaimed', txid);
  process.exit(0);
}

// Publish a new BCMR revision (e.g. icons) by spending the identity output (genesis out[0]) along the authchain.
if (cmd === 'bcmr') {
  if (!opt.registry) throw new Error('--registry https://host/bcmr.json is required');
  const rally = read(`src/rally.${network}.json`);
  const coins = (await provider.getUtxos(addr(organizerLock))).filter((u) => !u.token);
  // authhead: follow out[0] from genesis until it is unspent
  const head = rally.authHead ?? rally.genesisTx;
  const identity = coins.find((u) => u.txid === head && u.vout === 0);
  if (!identity) throw new Error(`identity output ${head}:0 is spent or missing; set authHead in src/rally.${network}.json`);
  const fee = coins.filter((u) => u !== identity).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  const minor = (rally.bcmrMinor ?? 0) + 1;
  const { body, hash, uri } = registry(rally, opt.registry, minor);
  writeFileSync(new URL('public/bcmr.json', root), body);
  const { txid } = await new TransactionBuilder({ provider })
    .addInput(identity, signer.unlockP2PKH())
    .addInput(fee, signer.unlockP2PKH())
    .addOutput({ to: organizerLock, amount: DUST }) // out[0] = next identity output
    .addOpReturnOutput(['BCMR', `0x${hash}`, uri])
    .addOutput({ to: organizerLock, amount: identity.satoshis + fee.satoshis - DUST - 1500n })
    .send();
  write(`src/rally.${network}.json`, { ...rally, authHead: txid, bcmrMinor: minor });
  console.log('BCMR revision published', txid);
  process.exit(0);
}

if (cmd !== 'deploy') throw new Error('usage: rally.mjs address|deploy|reclaim|bcmr --network chipnet|mainnet');

const cfg = read(opt.config ?? 'scripts/rally.config.json');
checkRallyConfig(cfg);

let merchantLock = organizerLock;
if (opt['merchant-address']) {
  const r = cashAddressToLockingBytecode(opt['merchant-address']);
  if (typeof r === 'string') throw new Error(r);
  merchantLock = r.bytecode;
}
cfg.merchants = cfg.merchants.map((m) => ({ ...m, lock: binToHex(merchantLock) }));

// proof of presence: stalls marked `presence: true` get a device key; the CLI keeps it next to the organizer key
// (in a real rally each stall generates its own on the app's #/device page and only hands over the public key)
const presenceFile = new URL(`scripts/.presence.${network}.json`, root);
const devices = existsSync(presenceFile) ? JSON.parse(readFileSync(presenceFile)) : {};
cfg.merchants = cfg.merchants.map(({ presence, ...m }) => {
  if (!presence) return m;
  devices[m.id] ??= binToHex(generatePrivateKey());
  return { ...m, presenceKey: binToHex(secp256k1.derivePublicKeyCompressed(hexToBin(devices[m.id]))) };
});
if (cfg.merchants.some((m) => m.presenceKey)) {
  if (cfg.levy === undefined) throw new Error('proof of presence needs a levy rally (StampMinter3)');
  writeFileSync(presenceFile, JSON.stringify(devices));
}

// 1. genesis needs an outpoint with vout 0: consolidate into one if there is none
let coins = await provider.getUtxos(addr(organizerLock));
coins = coins.filter((u) => !u.token);
const total = coins.reduce((s, u) => s + u.satoshis, 0n);
const need = genesisNeed(cfg);
if (total < need) throw new Error(`fund ${addr(organizerLock, true)} with at least ${need} sats (has ${total})`);
let base = coins.find((u) => u.vout === 0 && u.satoshis >= need);
if (!base) {
  const fee = 200n + 160n * BigInt(coins.length); // ~148 bytes per P2PKH input at 1 sat/byte, rounded up
  const tb = new TransactionBuilder({ provider });
  coins.forEach((u) => tb.addInput(u, signer.unlockP2PKH()));
  const { txid } = await tb.addOutput({ to: organizerLock, amount: total - fee }).send();
  console.log('prepared vout-0 coin', txid);
  base = { txid, vout: 0, satoshis: total - fee, lockingBytecode: binToHex(organizerLock) };
}

// 2. the rally record, then the optional BCMR registry so wallets show names (stamp type = first commitment byte)
const rally = planRally({ network, cfg, organizerPub: binToHex(pub), baseTxid: base.txid });
let bcmr;
if (opt.registry) {
  bcmr = registry(rally, opt.registry);
  writeFileSync(new URL('public/bcmr.json', root), bcmr.body);
}

// 3. genesis
const { builder, vault } = buildGenesis({ provider, rally, rewardsInPool: cfg.rewardsInPool, base: { utxo: base, unlocker: signer.unlockP2PKH() }, organizerLock, bcmr });
const { txid } = await builder.send();

const outFile = opt.out ?? `src/rally.${network}.json`; // --out: keep the app's default rally, e.g. for a link-only rally
write(outFile, { ...rally, genesisTx: txid });
if (opt.out) console.log('share link', `https://jelajah-bch.vercel.app/?r=${deflateRawSync(JSON.stringify({ ...rally, genesisTx: txid })).toString('base64url')}`);
console.log(`rally "${cfg.name}" live on ${network}`);
console.log('category', rally.category);
console.log('genesis ', txid);
console.log('vault   ', vault.tokenAddress);

// stamp type = first commitment byte; icons are rendered from the app's #/art page into public/art/<type>.png
function registry(rally, registryUrl, minor = 0) {
  const now = new Date().toISOString();
  const web = new URL('.', registryUrl).href;
  const icon = (type) => new URL(`art/${type}.png`, web).href;
  const body = JSON.stringify({
    $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
    version: { major: 1, minor, patch: 0 },
    latestRevision: now,
    registryIdentity: { name: 'Jelajah', description: 'Stamp rallies on Bitcoin Cash', uris: { icon: icon('00'), web } },
    identities: {
      [rally.category]: {
        [now]: {
          name: `${rally.name} stamps`,
          description: rally.description,
          token: {
            category: rally.category, symbol: 'JELAJAH',
            nfts: {
              parse: {
                bytecode: '00d2517f75', // OP_0 OP_UTXOTOKENCOMMITMENT OP_1 OP_SPLIT OP_DROP -> first byte
                types: Object.fromEntries([
                  ['00', { name: `${rally.name} Trophy`, description: `Completed ${rally.name}`, uris: { icon: icon('00') } }],
                  ...rally.merchants.map((m) => {
                    const type = m.id.toString(16).padStart(2, '0');
                    return [type, { name: `${m.emoji} ${m.name} stamp`, description: m.tagline, uris: { icon: icon(type) } }];
                  }),
                ]),
              },
            },
          },
          uris: { icon: icon('00'), web },
        },
      },
    },
  }, null, 2) + '\n';
  return { body, hash: createHash('sha256').update(body).digest('hex'), uri: registryUrl.replace(/^https:\/\//, '') };
}
