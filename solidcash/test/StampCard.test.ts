import { describe, expect, it } from 'vitest';
import { ethers } from '@solidcash/solidhat/hardhat3';

const PRICE = 1_000n, NEEDED = 3n, REWARD = 2_000n;
const sigOf = (signer: any) => signer._sigTemplate; // the signer's SignatureTemplate, for `sig` arguments

async function deployed() {
  const [stall, alice, mallory] = await ethers.getSigners(3);
  const Factory = await ethers.getContractFactory('StampCard', stall);
  const card = await Factory.deploy(stall.publicKey, PRICE, NEEDED, REWARD);
  await card.waitForDeployment();
  await (await card.fund({ value: 20_000n })).wait();
  return { card, stall, alice, mallory };
}
const visit = async (card: any, payer: any, customer: any, value = PRICE) => (await card.connect(payer).visit(customer.pkh, { value })).wait();
const rejects = async (p: () => Promise<any>) => {
  let failed = false;
  try { const tx = await p(); await tx?.wait?.(); } catch { failed = true; }
  expect(failed).toBe(true);
};

describe('StampCard (SolidCash)', () => {
  it('lifecycle: fund -> 3 visits -> redeem -> tier', async () => {
    const { card, alice } = await deployed();
    for (let i = 0; i < 3; i++) await visit(card, alice, alice);
    expect(await card.visits()).toBe(3n);
    expect((await card.cards(alice.pkh)).stamps).toBe(3n);
    await (await card.connect(alice).redeem(alice.publicKey, sigOf(alice))).wait();
    const after = await card.cards(alice.pkh);
    expect(after.stamps).toBe(0n);
    expect(after.lifetime).toBe(3n);
    expect(after.redeemed).toBe(1n);
    expect(await card.rewardsPaid()).toBe(REWARD);
    expect(await card.tierOf(alice.pkh)).toBe(1n); // Tier.Regular
  });

  it('rejects underpaying the stall', async () => {
    const { card, alice } = await deployed();
    await rejects(() => card.connect(alice).visit(alice.pkh, { value: PRICE - 1n }));
  });

  it('rejects redeeming a card that is not full', async () => {
    const { card, alice } = await deployed();
    await visit(card, alice, alice); await visit(card, alice, alice);
    await rejects(() => card.connect(alice).redeem(alice.publicKey, sigOf(alice)));
  });

  it("rejects redeeming someone else's card: their pubkey with your signature", async () => {
    const { card, alice, mallory } = await deployed();
    for (let i = 0; i < 3; i++) await visit(card, alice, alice);
    await rejects(() => card.connect(mallory).redeem(alice.publicKey, sigOf(mallory)));
    expect((await card.cards(alice.pkh)).stamps).toBe(3n);
  });

  it('rejects withdraw and pause signed by anyone but the stall', async () => {
    const { card, mallory } = await deployed();
    await rejects(() => card.connect(mallory).withdraw(sigOf(mallory), 1_000n));
    await rejects(() => card.connect(mallory).setPaused(sigOf(mallory), true));
  });

  it('a paused card takes no visits; the stall can resume and withdraw', async () => {
    const { card, stall, alice } = await deployed();
    await (await card.connect(stall).setPaused(sigOf(stall), true)).wait();
    await rejects(() => card.connect(alice).visit(alice.pkh, { value: PRICE }));
    await (await card.connect(stall).setPaused(sigOf(stall), false)).wait();
    await visit(card, alice, alice);
    expect(await card.visits()).toBe(1n);
    await (await card.connect(stall).withdraw(sigOf(stall), 1_000n)).wait();
  });

  it('refuses to deploy a farmable card (reward >= a full card)', async () => {
    const [stall] = await ethers.getSigners(1);
    const Factory = await ethers.getContractFactory('StampCard', stall);
    await rejects(async () => { const c = await Factory.deploy(stall.publicKey, PRICE, NEEDED, PRICE * NEEDED); await c.waitForDeployment(); return c; });
  });
});
