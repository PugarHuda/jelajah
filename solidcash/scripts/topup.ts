// Move test coins from signer 0 (stall) to signer 1 (customer) as several coins: each paid visit spends its own.
import { ethers } from '@solidcash/solidhat/hardhat3';
import { ElectrumNetworkProvider, TransactionBuilder } from 'cashscript';
const [stall, customer] = await ethers.getSigners(2) as any[];
const net = process.env.SOLIDCASH_NETWORK ?? 'chipnet';
const p = new ElectrumNetworkProvider(net as any);
const coins = (await p.getUtxos(stall.address)).filter((u: any) => !u.token);
const total = coins.reduce((s: bigint, c: any) => s + c.satoshis, 0n);
const each = BigInt(process.env.AMOUNT ?? '5000'), n = BigInt(process.env.COUNT ?? '4');
const tb = new TransactionBuilder({ provider: p });
coins.forEach((c: any) => tb.addInput(c, stall._sigTemplate.unlockP2PKH()));
const to = process.env.TO ?? customer.address;
for (let i = 0n; i < n; i++) tb.addOutput({ to, amount: each });
tb.addOutput({ to: stall.address, amount: total - each * n - 300n - 160n * BigInt(coins.length) });
console.log('topup', (await tb.send()).txid);
