// The StampCard lifecycle on a real network: deploy -> fund the pot -> 3 paid visits -> redeem.
//   SOLIDCASH_MNEMONIC_CHIPNET=… npx solidhat run scripts/lifecycle.ts --network chipnet
//   (--network mainnet with SOLIDCASH_MNEMONIC_MAINNET). Signer 0 is the stall, signer 1 the customer; fund both first
//   (`npx solidhat run scripts/addresses.ts --network …` prints them).
import { writeFileSync } from 'node:fs';
import { ethers, network } from '@solidcash/solidhat/hardhat3';

const PRICE = BigInt(process.env.PRICE ?? 1_000), NEEDED = 3n, REWARD = BigInt(process.env.REWARD ?? 2_000), POT = BigInt(process.env.POT ?? 4_000);
const [stall, customer] = await ethers.getSigners(2);
const log: Record<string, string> = {};
const step = async (name: string, p: Promise<any>) => {
  const tx = await p;
  await tx.wait?.();
  const id = tx.txid ?? tx.hash ?? tx.deploymentTransaction?.()?.txid;
  log[name] = id;
  console.log(name.padEnd(10), id);
};

const Factory = await ethers.getContractFactory('StampCard', stall);
const card = await Factory.deploy(stall.publicKey, PRICE, NEEDED, REWARD);
await card.waitForDeployment();
log.deploy = card.deploymentTransaction().txid;
console.log('deploy    ', log.deploy, await card.getAddress());
await step('fund', card.fund({ value: POT }));
const asCustomer = card.connect(customer);
for (let i = 1; i <= 3; i++) await step(`visit${i}`, asCustomer.visit(customer.pkh, { value: PRICE }));
await step('redeem', asCustomer.redeem(customer.publicKey, (customer as any)._sigTemplate));
const c = await card.cards(customer.pkh);
console.log('card      ', { stamps: c.stamps, lifetime: c.lifetime, redeemed: c.redeemed }, 'tier', await card.tierOf(customer.pkh));
writeFileSync(`deployments/${network.name}.json`, JSON.stringify({ network: network.name, address: await card.getAddress(), stall: stall.address, customer: customer.address, txs: log }, null, 2) + '\n');
