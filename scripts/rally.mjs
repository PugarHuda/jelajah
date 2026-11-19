// Organizer CLI: create a key, then deploy a rally (genesis + minters + vault) on chipnet or mainnet.
//   node scripts/rally.mjs address  --network chipnet          print the organizer funding address
//   node scripts/rally.mjs deploy   --network chipnet [--registry https://host/bcmr.json]
//   node scripts/rally.mjs reclaim  --network chipnet          take back the pool after the rally ends
// Merchants are paid at --merchant-address (default: the organizer) — set real stall addresses for a real rally.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
  secp256k1, hash160, binToHex, hexToBin, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress,
  encodePrivateKeyWif, decodePrivateKeyWif, cashAddressToLockingBytecode, generatePrivateKey,
} from '@bitauth/libauth';

const root = new URL('../', import.meta.url);
const read = (p) => JSON.parse(readFileSync(new URL(p, root)));
const write = (p, v) => writeFileSync(new URL(p, root), JSON.stringify(v, null, 2) + '\n');

const { positionals: [cmd], values: opt } = parseArgs({
  allowPositionals: true,
  options: { network: { type: 'string', default: 'chipnet' }, registry: { type: 'string' }, 'merchant-address': { type: 'string' } },
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

const StampMinter = read('src/contracts/StampMinter.json');
const RewardVault = read('src/contracts/RewardVault.json');

if (cmd === 'reclaim') {
  const rally = read(`src/rally.${network}.json`);
  const vault = new Contract(RewardVault, vaultArgs(rally), { provider });
  const [v] = await vault.getUtxos();
  const { txid } = await new TransactionBuilder({ provider })
    .addInput(v, vault.unlock.reclaim(signer))
    .addOutput({ to: organizerLock, amount: v.satoshis - 2000n, token: v.token })
    .setLocktime(rally.endTime)
    .send();
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

const cfg = read('scripts/rally.config.json');
const cheapest = cfg.merchants.map((m) => m.price).sort((a, b) => a - b).slice(0, cfg.needed).reduce((a, b) => a + b, 0);
if (!(cfg.reward < cheapest)) throw new Error(`anti-farming: reward ${cfg.reward} must be < cheapest set ${cheapest}`);
if (cfg.merchants.some((m) => m.id < 1 || m.id > 127)) throw new Error('merchant ids must be 1..127');

let merchantLock = organizerLock;
if (opt['merchant-address']) {
  const r = cashAddressToLockingBytecode(opt['merchant-address']);
  if (typeof r === 'string') throw new Error(r);
  merchantLock = r.bytecode;
}

// 1. genesis needs an outpoint with vout 0: consolidate into one if there is none
let coins = await provider.getUtxos(addr(organizerLock));
coins = coins.filter((u) => !u.token);
const total = coins.reduce((s, u) => s + u.satoshis, 0n);
// + DUST: the vault UTXO carries the minting NFT, so it must keep dust after the last claim
const pool = BigInt(cfg.reward) * BigInt(cfg.rewardsInPool) + DUST;
const need = pool + DUST * BigInt(cfg.merchants.length + 2) + 10_000n;
if (total < need) throw new Error(`fund ${addr(organizerLock, true)} with at least ${need} sats (has ${total})`);
let base = coins.find((u) => u.vout === 0 && u.satoshis >= need);
if (!base) {
  const tb = new TransactionBuilder({ provider });
  coins.forEach((u) => tb.addInput(u, signer.unlockP2PKH()));
  const { txid } = await tb.addOutput({ to: organizerLock, amount: total - 2000n }).send();
  console.log('prepared vout-0 coin', txid);
  base = { txid, vout: 0, satoshis: total - 2000n, lockingBytecode: binToHex(organizerLock) };
}

// 2. category = txid of the spent vout-0 outpoint; the vault is parameterised with it (internal byte order)
const category = base.txid;
const vmCategory = binToHex(hexToBin(category).reverse());
const endTime = Math.floor(Date.now() / 1000) + cfg.durationDays * 86400;
const rally = {
  network, name: cfg.name, description: cfg.description, category, vmCategory,
  needed: cfg.needed, reward: cfg.reward, endTime, organizerPub: binToHex(pub),
  merchants: cfg.merchants.map((m) => ({ ...m, lock: binToHex(merchantLock) })),
};
const minters = rally.merchants.map((m) => new Contract(StampMinter, minterArgs(m), { provider }));
const vault = new Contract(RewardVault, vaultArgs(rally), { provider });

// 3. optional BCMR registry so wallets show names: stamp type = first commitment byte
let bcmr;
if (opt.registry) {
  bcmr = registry(rally, opt.registry);
  writeFileSync(new URL('public/bcmr.json', root), bcmr.body);
}

// 4. genesis: out[0] identity (plain BCH, stays with organizer), one minting NFT per minter, one for the vault
const minting = { category, amount: 0n, nft: { capability: 'minting', commitment: '' } };
const tb = new TransactionBuilder({ provider })
  .addInput(base, signer.unlockP2PKH())
  .addOutput({ to: organizerLock, amount: DUST });
minters.forEach((c) => tb.addOutput({ to: c.tokenAddress, amount: DUST, token: minting }));
tb.addOutput({ to: vault.tokenAddress, amount: pool, token: minting });
if (bcmr) tb.addOpReturnOutput(['BCMR', `0x${bcmr.hash}`, bcmr.uri]);
const spent = DUST * BigInt(minters.length + 1) + pool;
tb.addOutput({ to: organizerLock, amount: base.satoshis - spent - 3000n });
const { txid } = await tb.send();

write(`src/rally.${network}.json`, { ...rally, genesisTx: txid });
console.log(`rally "${cfg.name}" live on ${network}`);
console.log('category', category);
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

function minterArgs(m) { return [m.lock, BigInt(m.price), m.id.toString(16).padStart(2, '0')]; }
function vaultArgs(r) { return [r.vmCategory, BigInt(r.needed), BigInt(r.reward), r.organizerPub, BigInt(r.endTime)]; }
