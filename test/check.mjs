// Runs the whole Jelajah loop on CashScript's mock network, which validates every tx against the BCH VM.
// npm run check  -> PASS lines, exits non-zero on the first failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, hash160, binToHex, hexToBin, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';

const artifact = (n) => JSON.parse(readFileSync(new URL(`../src/contracts/${n}.json`, import.meta.url)));
const StampMinter = artifact('StampMinter');
const RewardVault = artifact('RewardVault');
const provider = new MockNetworkProvider();

const key = (n) => {
  const priv = new Uint8Array(32).fill(n);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { pub, pkh, lock: binToHex(encodeLockingBytecodeP2pkh(pkh)), sig: new SignatureTemplate(priv) };
};
const alice = key(1), bob = key(2), organizer = key(9);
const merchants = [key(11), key(12), key(13)];

const category = binToHex(crypto.getRandomValues(new Uint8Array(32)));
const vmCategory = binToHex(hexToBin(category).reverse()); // introspection sees the category in internal byte order
const PRICE = 10_000n, REWARD = 20_000n, DUST = 1_000n, END = 1_800_000_000n;
const minting = { category, amount: 0n, nft: { capability: 'minting', commitment: '' } };

const minters = merchants.map((m, i) => {
  const c = new Contract(StampMinter, [m.lock, PRICE, `0${i + 1}`], { provider });
  provider.addUtxo(c.address, randomUtxo({ satoshis: DUST, token: minting }));
  return c;
});
const vault = new Contract(RewardVault, [vmCategory, 3n, REWARD, binToHex(organizer.pub), END], { provider });
provider.addUtxo(vault.address, randomUtxo({ satoshis: 100_000n, token: minting }));

const fund = (who, sats = 50_000n) => provider.addUtxo(who.lock, randomUtxo({ satoshis: sats }));
const nftOut = (to, commitment) => ({ to: hexToBin(to.lock), amount: DUST, token: { category, amount: 0n, nft: { capability: 'none', commitment } } });

async function buyStamp(i, buyer, { pay = PRICE, id = i + 1 } = {}) {
  const [minterUtxo] = await minters[i].getUtxos();
  const coin = fund(buyer);
  return new TransactionBuilder({ provider })
    .addInput(minterUtxo, minters[i].unlock.stamp())
    .addInput(coin, buyer.sig.unlockP2PKH())
    .addOutput({ to: minters[i].tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchants[i].lock), amount: pay })
    .addOutput(nftOut(buyer, `0${id}` + binToHex(buyer.pkh)))
    .addOutput({ to: hexToBin(buyer.lock), amount: coin.satoshis - pay - DUST - 2_000n })
    .send();
}

async function claim(stamps, holder, rewardTo, { trophy = '00' } = {}) {
  const [vaultUtxo] = await vault.getUtxos();
  const tb = new TransactionBuilder({ provider }).addInput(vaultUtxo, vault.unlock.claim());
  for (const s of stamps) tb.addInput(s, holder.sig.unlockP2PKH());
  return tb
    .addOutput({ to: vault.tokenAddress, amount: vaultUtxo.satoshis - REWARD, token: vaultUtxo.token })
    .addOutput({ to: hexToBin(rewardTo.lock), amount: REWARD + DUST * BigInt(stamps.length - 1) - 2_000n })
    .addOutput(nftOut(rewardTo, trophy + binToHex(rewardTo.pkh)))
    .send();
}

async function reclaim(locktime) {
  const [vaultUtxo] = await vault.getUtxos();
  return new TransactionBuilder({ provider })
    .addInput(vaultUtxo, vault.unlock.reclaim(organizer.sig))
    .addOutput({ to: hexToBin(organizer.lock), amount: vaultUtxo.satoshis - 2_000n, token: vaultUtxo.token })
    .setLocktime(locktime)
    .send();
}

const nftsOf = async (who) => (await provider.getUtxosForLockingBytecode(who.lock)).filter((u) => u.token?.nft);
const stampsOf = async (who) => (await nftsOf(who))
  .filter((u) => !u.token.nft.commitment.startsWith('00'))
  .sort((a, b) => a.token.nft.commitment.localeCompare(b.token.nft.commitment));

// must be rejected by a contract require(), not by some unrelated error
const fails = async (name, fn) => {
  const err = await fn().then(() => null, (e) => e);
  assert.ok(err, `${name}: was accepted`);
  const line = String(err.message).split('\n').find((l) => /require statement failed/i.test(l));
  assert.ok(line, `${name}: rejected for an unexpected reason: ${err.message.slice(0, 300)}`);
  console.log('PASS (rejected)', name, '->', line.match(/\w+\.cash:\d+/)?.[0]);
};

await fails('underpaying the merchant', () => buyStamp(0, alice, { pay: PRICE - 1n }));
await fails('stamp with a forged merchant id', () => buyStamp(0, alice, { id: 2 }));
for (const i of [0, 1, 2]) await buyStamp(i, alice);
assert.equal((await stampsOf(alice)).length, 3);
console.log('PASS alice bought at 3 merchants and holds 3 stamps');

await buyStamp(0, bob); await buyStamp(0, bob); await buyStamp(1, bob);
await fails('duplicate merchant cannot complete a set', async () => claim(await stampsOf(bob), bob, bob));
await fails('reward cannot be redirected away from the original buyer', async () => claim(await stampsOf(alice), alice, bob));
await fails('trophy must carry merchant id 0x00', async () => claim(await stampsOf(alice), alice, alice, { trophy: '05' }));

await claim(await stampsOf(alice), alice, alice);
const after = await nftsOf(alice);
assert.equal(after.length, 1);
assert.equal(after[0].token.nft.commitment, '00' + binToHex(alice.pkh));
assert.equal((await vault.getUtxos())[0].satoshis, 100_000n - REWARD);
console.log('PASS alice burned a full set -> reward + Trophy NFT; vault paid exactly one reward');

await fails('organizer cannot reclaim before the rally ends', () => reclaim(Number(END) - 1));
await reclaim(Number(END));
assert.equal((await vault.getUtxos()).length, 0);
console.log('PASS organizer reclaims the rest after the rally ends');
