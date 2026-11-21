// Runs the whole Jelajah loop on CashScript's mock network, which validates every tx against the BCH VM.
// npm run check  -> PASS lines, exits non-zero on the first failure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo } from 'cashscript';
import { secp256k1, sha256, hash160, binToHex, hexToBin, encodeLockingBytecodeP2pkh, cashAddressToLockingBytecode } from '@bitauth/libauth';

const artifact = (n) => JSON.parse(readFileSync(new URL(`../src/contracts/${n}.json`, import.meta.url)));
const StampMinter = artifact('StampMinter');
const RewardVault = artifact('RewardVault');
const provider = new MockNetworkProvider();

const key = (n) => {
  const priv = new Uint8Array(32).fill(n);
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  const pkh = hash160(pub);
  return { priv, pub, pkh, lock: binToHex(encodeLockingBytecodeP2pkh(pkh)), sig: new SignatureTemplate(priv) };
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

// ---- StampMinter2: member price for trophy holders, two lanes (minter coins) for one stall
const StampMinter2 = artifact('StampMinter2');
const MEMBER = 8_000n;
const m2 = new Contract(StampMinter2, [merchants[0].lock, PRICE, MEMBER, '01'], { provider });
for (let l = 0; l < 2; l++) provider.addUtxo(m2.address, randomUtxo({ satoshis: DUST, token: minting }));

async function buy2(buyer, { pay = PRICE, trophy, trophyTo = buyer, lane = 0 } = {}) {
  const minterUtxo = (await m2.getUtxos()).filter((u) => u.token)[lane];
  const coin = fund(buyer);
  const tb = new TransactionBuilder({ provider }).addInput(minterUtxo, m2.unlock.stamp());
  if (trophy) tb.addInput(trophy, buyer.sig.unlockP2PKH());
  tb.addInput(coin, buyer.sig.unlockP2PKH())
    .addOutput({ to: m2.tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchants[0].lock), amount: pay })
    .addOutput(nftOut(buyer, '01' + binToHex(buyer.pkh)));
  if (trophy) tb.addOutput({ to: hexToBin(trophyTo.lock), amount: trophy.satoshis, token: trophy.token });
  return tb.addOutput({ to: hexToBin(buyer.lock), amount: coin.satoshis - pay - DUST - 2_000n }).send();
}
const trophyOf = async (who) => (await nftsOf(who)).find((u) => u.token.nft.commitment.startsWith('00'));

await fails('member price without a trophy', () => buy2(bob, { pay: MEMBER }));
await fails('member keeps the discount but sends the trophy away', async () => buy2(alice, { pay: MEMBER, trophy: await trophyOf(alice), trophyTo: bob }));
provider.addUtxo(bob.lock, randomUtxo({ satoshis: DUST, token: { category, amount: 0n, nft: { capability: 'none', commitment: '00' + binToHex(alice.pkh) } } }));
await fails("someone else's (traded) trophy gives no discount", async () => buy2(bob, { pay: MEMBER, trophy: await trophyOf(bob) }));
await buy2(alice, { pay: MEMBER, trophy: await trophyOf(alice) });
assert.ok(await trophyOf(alice), 'trophy came back');
assert.equal((await stampsOf(alice)).length, 1);
console.log('PASS trophy holder bought at the member price and kept the trophy');

await buy2(bob, { lane: 0 }); await buy2(bob, { lane: 1 });
assert.equal((await m2.getUtxos()).filter((u) => u.token).length, 2);
console.log('PASS two lanes of one stall both mint, and both lanes stay open');

// ---- StampMinter3 + RewardVault2: every stamp pays a levy into the vault, so a set funds its own reward
const StampMinter3 = artifact('StampMinter3'), RewardVault2 = artifact('RewardVault2');
const LEVY = 8_500n; // 3 x 8,500 covers REWARD 20,000 + merge fees + vault dust: colluding stalls pay the reward themselves
const BONUS = 26_000n; // 4 stalls: 4 x (8,500 - 1,000) - 1,000 >= 26,000, so the bonus tier is collusion-proof too
const vault2 = new Contract(RewardVault2, [vmCategory, 3n, REWARD, 4n, BONUS, LEVY, binToHex(organizer.pub), END], { provider });
const vault2Lock = binToHex(cashAddressToLockingBytecode(vault2.address).bytecode);
provider.addUtxo(vault2.address, randomUtxo({ satoshis: DUST, token: minting })); // seeded with dust only: no organizer money
const merchants3 = [...merchants, key(14)]; // a 4th stall for the bonus tier
const m3 = merchants3.map((m, i) => {
  const c = new Contract(StampMinter3, [m.lock, PRICE, MEMBER, `0${i + 1}`, vault2Lock, LEVY, ''], { provider });
  provider.addUtxo(c.address, randomUtxo({ satoshis: DUST, token: minting }));
  return c;
});
const carol = key(3);

async function buy3(i, buyer, { levy = LEVY, levyTo = vault2Lock } = {}) {
  const [minterUtxo] = (await m3[i].getUtxos()).filter((u) => u.token);
  const coin = fund(buyer);
  return new TransactionBuilder({ provider })
    .addInput(minterUtxo, m3[i].unlock.stamp(new Uint8Array(64))) // no presenceKey: the signature is ignored
    .addInput(coin, buyer.sig.unlockP2PKH())
    .addOutput({ to: m3[i].tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchants3[i].lock), amount: PRICE })
    .addOutput(nftOut(buyer, `0${i + 1}` + binToHex(buyer.pkh)))
    .addOutput({ to: hexToBin(levyTo), amount: levy })
    .addOutput({ to: hexToBin(buyer.lock), amount: coin.satoshis - PRICE - DUST - levy - 2_000n })
    .send();
}
const vaultCoins = async () => {
  const all = await vault2.getUtxos();
  return { vaultCoin: all.find((u) => u.token), levies: all.filter((u) => !u.token) };
};
async function merge({ to = vault2.tokenAddress, keep = 0n, first = 'vault', extraOut = false } = {}) {
  const { vaultCoin, levies } = await vaultCoins();
  const ins = first === 'vault' ? [vaultCoin, ...levies] : [...levies, vaultCoin];
  const total = ins.reduce((s, u) => s + u.satoshis, 0n);
  const tb = new TransactionBuilder({ provider });
  ins.forEach((u) => tb.addInput(u, vault2.unlock.merge()));
  tb.addOutput({ to, amount: total - 900n * BigInt(ins.length) - keep, token: ins[0].token });
  if (extraOut) tb.addOutput({ to: hexToBin(carol.lock), amount: keep });
  return tb.send();
}

await fails('stamp without paying the levy', () => buy3(0, carol, { levy: LEVY - 1n }));
await fails('levy paid somewhere other than the vault', () => buy3(0, carol, { levyTo: carol.lock }));
for (const i of [0, 1, 2]) await buy3(i, carol);
assert.equal((await vaultCoins()).levies.length, 3);
console.log('PASS 3 stamps each paid a levy coin into the vault address');

await fails('merge that sends the pool elsewhere', () => merge({ to: hexToBin(carol.lock) }));
await fails('merge that burns the minting NFT (a levy coin first)', () => merge({ first: 'levy' }));
await fails('merge that skims levies into a second output', () => merge({ keep: 5_000n, extraOut: true }));
await fails('merge that burns levies as fee', () => merge({ keep: 5_000n }));
await merge();
const pooled = (await vaultCoins()).vaultCoin.satoshis;
assert.ok(pooled >= DUST + 3n * LEVY - 4_000n);
console.log('PASS anyone merged the levies into the vault coin, unsigned:', pooled, 'sats');
{
  const { vaultCoin } = await vaultCoins();
  await fails('merge of the vault coin alone, paying the fee out of the pool', () => new TransactionBuilder({ provider })
    .addInput(vaultCoin, vault2.unlock.merge())
    .addOutput({ to: vault2.tokenAddress, amount: vaultCoin.satoshis - 990n, token: vaultCoin.token }) // within the 1000/input fee rule, so only the pool rule can reject it
    .send());
}

await buy3(0, bob); // a fresh levy coin for the next attack
{
  const { vaultCoin, levies } = await vaultCoins();
  const stamps = await stampsOf(carol);
  const tb = new TransactionBuilder({ provider }).addInput(vaultCoin, vault2.unlock.claim());
  stamps.forEach((s) => tb.addInput(s, carol.sig.unlockP2PKH()));
  tb.addInput(levies[0], vault2.unlock.merge()); // a levy coin smuggled in as a "fee coin"
  await fails('claim that pockets a levy coin as change', () => tb
    .addOutput({ to: vault2.tokenAddress, amount: vaultCoin.satoshis - REWARD, token: vaultCoin.token })
    .addOutput({ to: hexToBin(carol.lock), amount: REWARD - 3_000n }) // fee for the bigger vault script
    .addOutput(nftOut(carol, '00' + binToHex(carol.pkh)))
    .addOutput({ to: hexToBin(carol.lock), amount: levies[0].satoshis })
    .send());
}

{
  const { vaultCoin } = await vaultCoins();
  const tb = new TransactionBuilder({ provider }).addInput(vaultCoin, vault2.unlock.claim());
  for (const s of await stampsOf(carol)) tb.addInput(s, carol.sig.unlockP2PKH());
  await tb
    .addOutput({ to: vault2.tokenAddress, amount: vaultCoin.satoshis - REWARD, token: vaultCoin.token })
    .addOutput({ to: hexToBin(carol.lock), amount: REWARD + DUST * 2n - 2_000n })
    .addOutput(nftOut(carol, '00' + binToHex(carol.pkh)))
    .send();
}
console.log(`PASS carol's set was paid from its own levies (paid ${3n * LEVY} in levies, got ${REWARD} back): collusion earns nothing`);

// ---- tiers: 4 different stalls -> BONUS instead of REWARD
const dave = key(4);
for (const i of [0, 1, 2, 2, 3]) await buy3(i, dave); // stall 3 twice, for the duplicate attack
await merge();
async function claim2(stamps, pay, tier = pay === BONUS ? '02' : '') {
  const { vaultCoin } = await vaultCoins();
  const tb = new TransactionBuilder({ provider }).addInput(vaultCoin, vault2.unlock.claim());
  stamps.forEach((s) => tb.addInput(s, dave.sig.unlockP2PKH()));
  tb.addInput(fund(dave, 10_000n), dave.sig.unlockP2PKH()); // fee coin
  return tb
    .addOutput({ to: vault2.tokenAddress, amount: vaultCoin.satoshis - pay, token: vaultCoin.token })
    .addOutput({ to: hexToBin(dave.lock), amount: pay + 8_000n })
    .addOutput(nftOut(dave, '00' + binToHex(dave.pkh) + tier))
    .send();
}
{
  const all = await stampsOf(dave); // sorted: 01, 02, 03, 03, 04
  const four = [all[0], all[1], all[2], all[4]];
  await fails('bonus paid for only 3 stamps', () => claim2(four.slice(0, 3), BONUS));
  await fails('normal reward taken while burning 4 stamps (the vault forces the bonus path)', () => claim2(four, REWARD));
  await fails('bonus with a duplicate stall', () => claim2([all[0], all[1], all[2], all[3]], BONUS));
  await fails('bonus claim that mints a plain trophy instead of the bonus one', () => claim2(four, BONUS, ''));
  const before = (await vaultCoins()).vaultCoin.satoshis;
  await claim2(four, BONUS);
  assert.equal((await vaultCoins()).vaultCoin.satoshis, before - BONUS);
  console.log(`PASS dave burned 4 different stalls for the bonus tier (${BONUS} instead of ${REWARD}) and got the bonus trophy 00‖pkh‖02`);
}
{ // the bonus trophy is a membership card too
  const gold = (await nftsOf(dave)).find((u) => u.token.nft.commitment === '00' + binToHex(dave.pkh) + '02');
  const [minterUtxo] = (await m3[1].getUtxos()).filter((u) => u.token);
  const coin = fund(dave);
  await new TransactionBuilder({ provider })
    .addInput(minterUtxo, m3[1].unlock.stamp(new Uint8Array(64)))
    .addInput(gold, dave.sig.unlockP2PKH())
    .addInput(coin, dave.sig.unlockP2PKH())
    .addOutput({ to: m3[1].tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchants3[1].lock), amount: MEMBER })
    .addOutput(nftOut(dave, '02' + binToHex(dave.pkh)))
    .addOutput({ to: hexToBin(vault2Lock), amount: LEVY })
    .addOutput({ to: hexToBin(dave.lock), amount: gold.satoshis, token: gold.token })
    .addOutput({ to: hexToBin(dave.lock), amount: coin.satoshis - MEMBER - DUST - LEVY - 2_000n })
    .send();
  console.log('PASS the bonus trophy also gives the member price, and comes back');
}

// ---- proof of presence: this stall's minter wants its device's signature over rally ‖ stall ‖ buyer pkh
const stallDevice = key(21), otherDevice = key(22), erin = key(5);
const mP = new Contract(StampMinter3, [merchants3[0].lock, PRICE, MEMBER, '01', vault2Lock, LEVY, binToHex(stallDevice.pub)], { provider });
provider.addUtxo(mP.address, randomUtxo({ satoshis: DUST, token: minting }));
const outpointHex = (u) => binToHex(hexToBin(u.txid).reverse()) + binToHex(Uint8Array.of(u.vout, 0, 0, 0));
// sign(minterUtxo) -> sig: the signature covers the lane coin that this stamp spends
const presenceSig = (device, id, buyer, coin) => secp256k1.signMessageHashSchnorr(device.priv, sha256.hash(hexToBin(vmCategory + id + binToHex(buyer.pkh) + outpointHex(coin))));
async function buyP(buyer, sign) {
  const [minterUtxo] = (await mP.getUtxos()).filter((u) => u.token);
  const presence = sign(minterUtxo);
  const coin = fund(buyer);
  return new TransactionBuilder({ provider })
    .addInput(minterUtxo, mP.unlock.stamp(presence))
    .addInput(coin, buyer.sig.unlockP2PKH())
    .addOutput({ to: mP.tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(merchants3[0].lock), amount: PRICE })
    .addOutput(nftOut(buyer, '01' + binToHex(buyer.pkh)))
    .addOutput({ to: hexToBin(vault2Lock), amount: LEVY })
    .addOutput({ to: hexToBin(buyer.lock), amount: coin.satoshis - PRICE - DUST - LEVY - 2_000n })
    .send();
}
await fails('presence stall without the device signature', () => buyP(erin, () => new Uint8Array()));
await fails("presence signature made for someone else (a shared screenshot)", () => buyP(erin, (c) => presenceSig(stallDevice, '01', dave, c)));
await fails('presence signature from another device', () => buyP(erin, (c) => presenceSig(otherDevice, '01', erin, c)));
await fails('presence signature for another stall', () => buyP(erin, (c) => presenceSig(stallDevice, '02', erin, c)));
let used;
await buyP(erin, (c) => (used = presenceSig(stallDevice, '01', erin, c)));
console.log("PASS erin bought at a presence stall with the stall device's signature over her own pkh and that minter coin");
await fails('replaying a used presence code (the minter coin it named is gone)', () => buyP(erin, () => used));

// ---- PassportVault: a trophy from rally A + a trophy from rally B (same owner) -> reward + Passport NFT
{
  const PassportVault = artifact('PassportVault');
  const cat = () => binToHex(crypto.getRandomValues(new Uint8Array(32)));
  const vm = (c) => binToHex(hexToBin(c).reverse());
  const catA = cat(), catB = cat(), catP = cat();
  const PREWARD = 7_000n;
  const pv = new Contract(PassportVault, [vm(catA), vm(catB), PREWARD, binToHex(organizer.pub), END], { provider });
  provider.addUtxo(pv.address, randomUtxo({ satoshis: 50_000n, token: { category: catP, amount: 0n, nft: { capability: 'minting', commitment: '' } } }));
  const frank = key(6), gina = key(7);
  const give = (who, category, commitment) => provider.addUtxo(who.lock, randomUtxo({ satoshis: DUST, token: { category, amount: 0n, nft: { capability: 'none', commitment } } }));
  const pk = (who) => binToHex(who.pkh);
  const tA = give(frank, catA, '00' + pk(frank)), tB = give(frank, catB, '00' + pk(frank) + '02'); // the B one is a bonus trophy
  const tA2 = give(frank, catA, '00' + pk(frank)), tGina = give(gina, catB, '00' + pk(gina)), stamp = give(frank, catB, '01' + pk(frank));

  async function redeem(a, b, { to = frank, passport = pk(frank), keepB = false } = {}) {
    const [v] = (await pv.getUtxos()).filter((u) => u.token);
    const fee = fund(frank, 10_000n);
    const tb = new TransactionBuilder({ provider }).addInput(v, pv.unlock.claim())
      .addInput(a, frank.sig.unlockP2PKH()).addInput(b, (b === tGina ? gina : frank).sig.unlockP2PKH()).addInput(fee, frank.sig.unlockP2PKH())
      .addOutput({ to: pv.tokenAddress, amount: v.satoshis - PREWARD, token: v.token })
      .addOutput({ to: hexToBin(to.lock), amount: PREWARD })
      .addOutput({ to: hexToBin(to.lock), amount: DUST, token: { category: catP, amount: 0n, nft: { capability: 'none', commitment: passport } } });
    if (keepB) tb.addOutput({ to: hexToBin(frank.lock), amount: b.satoshis, token: b.token });
    return tb.addOutput({ to: hexToBin(frank.lock), amount: 10_000n + a.satoshis + (keepB ? 0n : b.satoshis) - DUST - 2_000n }).send();
  }
  await fails('passport from two trophies of the same rally', () => redeem(tA, tA2));
  await fails("passport from someone else's trophy", () => redeem(tA, tGina));
  await fails('passport from a stamp instead of a trophy', () => redeem(tA, stamp));
  await fails('passport reward paid to someone else', () => redeem(tA, tB, { to: gina, passport: pk(gina) }));
  await fails('passport claim that keeps a trophy', () => redeem(tA, tB, { keepB: true }));
  await redeem(tA, tB);
  const got = (await nftsOf(frank)).find((u) => u.token.category === catP);
  assert.equal(got?.token.nft.commitment, pk(frank));
  console.log('PASS frank traded trophies from two rallies for a Passport NFT and the passport reward');
}


// ---- SponsorPool: a voucher + a subsidy coin pay part of a stamp; the stall still gets its full price
{
  const SponsorPool = artifact('SponsorPool');
  const vcat = binToHex(crypto.getRandomValues(new Uint8Array(32)));
  const V = 3_000n;
  const pool = new Contract(SponsorPool, [vmCategory, binToHex(hexToBin(vcat).reverse()), V, binToHex(organizer.pub), END], { provider });
  const subsidy = () => provider.addUtxo(pool.address, randomUtxo({ satoshis: V }));
  const henry = key(8);
  const voucher = (amount = 1n, category = vcat) => provider.addUtxo(henry.lock, randomUtxo({ satoshis: DUST, token: { category, amount } }));

  // stamp at m3 stall 3 (levy minter): minter, subsidy, voucher, buyer coin
  async function sponsored({ coin = subsidy(), v = voucher(), pay = PRICE, payTo = merchants3[2].lock, trophyOut = false } = {}) {
    const [minterUtxo] = (await m3[2].getUtxos()).filter((u) => u.token);
    const own = fund(henry);
    const tb = new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: true }) // the voucher is burned on purpose
      .addInput(minterUtxo, m3[2].unlock.stamp(new Uint8Array(64)))
      .addInput(coin, pool.unlock.redeem())
      .addInput(v, henry.sig.unlockP2PKH())
      .addInput(own, henry.sig.unlockP2PKH())
      .addOutput({ to: m3[2].tokenAddress, amount: DUST, token: minterUtxo.token })
      .addOutput({ to: hexToBin(payTo), amount: pay })
      .addOutput(nftOut(henry, (trophyOut ? '00' : '03') + binToHex(henry.pkh)))
      .addOutput({ to: hexToBin(vault2Lock), amount: LEVY });
    // henry pays price - V himself: his change is what's left of his own coin
    return tb.addOutput({ to: hexToBin(henry.lock), amount: own.satoshis + coin.satoshis + v.satoshis - pay - DUST - LEVY - 2_000n }).send();
  }
  await fails('subsidy with a voucher of another category', () => sponsored({ v: voucher(1n, binToHex(crypto.getRandomValues(new Uint8Array(32)))) }));
  await fails('subsidy with 2 vouchers at once (only exactly one is accepted)', () => sponsored({ v: voucher(2n) }));
  await fails('subsidy coin of the wrong size', () => sponsored({ coin: provider.addUtxo(pool.address, randomUtxo({ satoshis: V * 3n })) }));
  await fails('subsidy diverted from the stall to the buyer', () => sponsored({ pay: PRICE - V })); // the minter wants the full price
  await fails('subsidy spent outside a rally purchase', async () => {
    const coin = subsidy(), v = voucher();
    return new TransactionBuilder({ provider, allowImplicitFungibleTokenBurn: true })
      .addInput(fund(henry), henry.sig.unlockP2PKH()).addInput(coin, pool.unlock.redeem()).addInput(v, henry.sig.unlockP2PKH())
      .addOutput({ to: hexToBin(henry.lock), amount: 50_000n + V + DUST - 2_000n }).send();
  });
  const before = (await provider.getUtxosForLockingBytecode(merchants3[2].lock)).length;
  await sponsored();
  assert.equal((await provider.getUtxosForLockingBytecode(merchants3[2].lock)).length, before + 1);
  console.log(`PASS henry bought a stamp with a sponsor voucher: the stall got its full ${PRICE}, henry paid ${PRICE - V} of it`);
}

// ---- addStall: the organizer opens a stall mid-rally; the vault derives the new minter's address itself
{
  const newStall = key(15);
  const args = [newStall.lock, 9_000n, 8_000n, '11', vault2Lock, LEVY, '']; // stall id 17
  const expected = new Contract(StampMinter3, args, { provider });
  async function add({ signer = organizer, to = expected.tokenAddress, id = 17n, keepValue = true, lanes = 2 } = {}) {
    const { vaultCoin } = await vaultCoins();
    const fee = fund(organizer, 10_000n);
    const tb = new TransactionBuilder({ provider })
      .addInput(vaultCoin, vault2.unlock.addStall(signer.sig, newStall.lock, 9_000n, 8_000n, id, ''))
      .addInput(fee, organizer.sig.unlockP2PKH())
      .addOutput({ to: vault2.tokenAddress, amount: keepValue ? vaultCoin.satoshis : vaultCoin.satoshis - 1_000n, token: vaultCoin.token });
    for (let l = 0; l < lanes; l++) tb.addOutput({ to, amount: DUST, token: { ...vaultCoin.token } });
    return tb.addOutput({ to: hexToBin(organizer.lock), amount: 10_000n - DUST * BigInt(lanes) - 2_000n + (keepValue ? 0n : 1_000n) }).send();
  }
  await fails('addStall signed by someone other than the organizer', () => add({ signer: bob }));
  await fails('addStall that sends the minting NFT to the organizer', () => add({ to: hexToBin(organizer.lock) }));
  await fails('addStall with a stall id below 17', () => add({ id: 5n }));
  await fails('addStall that takes sats out of the pool', () => add({ keepValue: false }));
  await add();
  assert.equal((await expected.getUtxos()).filter((u) => u.token).length, 2);
  console.log('PASS the organizer opened stall #17: the vault-derived address equals the real StampMinter3 address (2 lanes)');

  // and the new stall really mints: buy a stamp there
  const [minterUtxo] = (await expected.getUtxos()).filter((u) => u.token);
  const coin = fund(carol);
  await new TransactionBuilder({ provider })
    .addInput(minterUtxo, expected.unlock.stamp(new Uint8Array(64)))
    .addInput(coin, carol.sig.unlockP2PKH())
    .addOutput({ to: expected.tokenAddress, amount: DUST, token: minterUtxo.token })
    .addOutput({ to: hexToBin(newStall.lock), amount: 9_000n })
    .addOutput(nftOut(carol, '11' + binToHex(carol.pkh)))
    .addOutput({ to: hexToBin(vault2Lock), amount: LEVY })
    .addOutput({ to: hexToBin(carol.lock), amount: coin.satoshis - 9_000n - DUST - LEVY - 2_000n })
    .send();
  console.log('PASS carol bought a stamp at the stall added mid-rally');
}

{ // streak badge: consecutive days ending today or yesterday
  const { streakOf } = await import('../src/lib/tx.js');
  assert.equal(streakOf(['2026-11-19', '2026-11-20', '2026-11-21'], '2026-11-21'), 3);
  assert.equal(streakOf(['2026-11-19', '2026-11-20'], '2026-11-21'), 2); // today not bought yet: still alive
  assert.equal(streakOf(['2026-11-18', '2026-11-20'], '2026-11-22'), 0); // broken
  assert.equal(streakOf(['2026-10-31', '2026-11-01'], '2026-11-01'), 2); // across a month
  console.log('PASS streak counts consecutive days');
}
