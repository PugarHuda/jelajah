// Claim a Jelajah set through the XO engine (chipnet, or NET=mainnet): burn stamps from `needed` different stalls (bought with
// buy-stamp.mjs, all to the account's fixed buyer address) at the live RewardVault for the reward + a trophy.
//   node xo/buy-stamp.mjs 1 && node xo/buy-stamp.mjs 2 && node xo/buy-stamp.mjs 3 && node xo/claim-set.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Engine, XO_SUPPORTED_NETWORKS, DUST_LIMIT_SATOSHIS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { assembleBytecodeBCH, encodeDataPush, hexToBin, binToHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { jelajahStampTemplate } from './jelajah-template.mjs';
import { rallyContracts } from '../src/lib/tx.js';

const here = (p) => new URL(p, import.meta.url);
// NET=mainnet runs against the retired-but-live mainnet rally v1 (same original StampMinter + RewardVault); default chipnet
const net = process.env.NET === 'mainnet' ? 'mainnet' : 'chipnet';
const prefix = net === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = net === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';
const rallyFile = net === 'mainnet' ? '../scripts/rally.mainnet-v1.json' : './rally.chipnet-v1.json';
const rally = JSON.parse(readFileSync(here(rallyFile)));
const { mnemonic, buyer } = JSON.parse(readFileSync(here(`.wallet.${net}.json`)));
if (!buyer) throw new Error('buy stamps with xo/buy-stamp.mjs first');
const pkh = buyer.slice(6, 46);
const provider = new ElectrumNetworkProvider(net);
const { vault } = rallyContracts(rally, provider);

// the stamps: one per stall, bought by `buyer` (commitment = stall id ‖ pkh), lowest stall ids first
const held = (await provider.getUtxos(lockingBytecodeToCashAddress({ bytecode: hexToBin(buyer), prefix }).address))
  .filter((u) => u.token?.category === rally.category && u.token.nft?.commitment.slice(2) === pkh);
const byStall = new Map();
for (const u of held) byStall.set(u.token.nft.commitment.slice(0, 2), u);
const stamps = [...byStall.entries()].sort(([a], [b]) => parseInt(a, 16) - parseInt(b, 16)).slice(0, rally.needed).map(([, u]) => u);
if (stamps.length < rally.needed) throw new Error(`need stamps from ${rally.needed} stalls, have ${stamps.length}`);
const [vaultCoin] = (await vault.getUtxos()).filter((u) => u.token?.nft?.capability === 'minting');

const engine = await Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS[net] });
try {
  const p2pkh = await engine.importTemplate(p2pkhTemplate);
  await engine.setDefaultPolicies({
    change: { templateIdentifier: p2pkh.templateIdentifier },
    receive: { templateIdentifier: p2pkh.templateIdentifier },
    address: { templateIdentifier: p2pkh.templateIdentifier },
  });
  const { templateIdentifier } = await engine.importTemplate(jelajahStampTemplate);
  for (const inv of await engine.listInvitations()) {
    const iid = inv.invitation?.invitationIdentifier ?? inv.invitationIdentifier;
    if (iid) await engine.archiveInvitation(iid).catch(() => {});
  }

  // the template's vault unlocking script with this rally's values, checked byte for byte against the live vault
  const s = jelajahStampTemplate.scripts;
  const asm = `OP_0 <${s.vaultRedeemBytecode}>`
    .replace('<endTime>', `<${rally.endTime}>`).replace('<organizerPub>', `<0x${rally.organizerPub}>`)
    .replace('<reward>', `<${rally.reward}>`).replace('<needed>', `<${rally.needed}>`).replace('<rallyVmCategory>', `<0x${rally.vmCategory}>`);
  const redeem = assembleBytecodeBCH(asm.slice('OP_0 <'.length, -1));
  if (!redeem.success) throw new Error(JSON.stringify(redeem.errors));
  if (binToHex(redeem.bytecode) !== vault.bytecode) throw new Error('template vault script differs from the live vault');
  const unlocking = Uint8Array.from([0x00, ...encodeDataPush(redeem.bytecode)]);

  const v = (variableIdentifier, value) => ({ variableIdentifier, roleIdentifier: 'buyer', value });
  // wait until the engine tracks the stamps (it syncs headers first)
  for (let i = 0; i < 60; i++) {
    const own = await engine.listUnspentOutputs();
    if (stamps.every((st) => own.some((o) => (typeof o.outpointTransactionHash === 'string' ? o.outpointTransactionHash : binToHex(o.outpointTransactionHash)) === st.txid && o.outpointIndex === st.vout))) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const created = await engine.createInvitation({
    templateIdentifier,
    actionIdentifier: 'claimSet',
    roleIdentifier: 'buyer',
    variables: [
      v('rallyCategory', rally.category), v('rallyVmCategory', rally.vmCategory), v('needed', BigInt(rally.needed)),
      v('reward', BigInt(rally.reward)), v('organizerPub', rally.organizerPub), v('endTime', BigInt(rally.endTime)),
      v('vaultSatoshis', vaultCoin.satoshis), v('vaultRemaining', vaultCoin.satoshis - BigInt(rally.reward)),
      v('buyerLockingScript', buyer), v('trophyCommitmentHex', '00' + pkh),
    ],
    inputs: [
      { outpointTransactionHash: hexToBin(vaultCoin.txid), outpointIndex: vaultCoin.vout, inputIdentifier: 'vaultInput', unlockingBytecode: unlocking },
      ...stamps.map((st) => ({ outpointTransactionHash: hexToBin(st.txid), outpointIndex: st.vout })),
    ],
  });
  const id = created.invitation.invitationIdentifier;
  await engine.appendInvitation(id, {
    templateIdentifier,
    actionIdentifier: 'claimSet',
    outputs: [{ outputIdentifier: 'vaultOutput' }, { outputIdentifier: 'rewardOutput' }, { outputIdentifier: 'trophyOutput' }],
  });
  const leftover = await engine.calculateChange(id);
  const fee = await engine.estimateTransactionFee(id);
  if (leftover.valueSatoshis - BigInt(fee) >= BigInt(DUST_LIMIT_SATOSHIS)) await engine.addChangeToInvitation(id);
  for (const i of await engine.listOwnInputIndexes(id)) await engine.signInvitation(id, i);
  console.log('unsigned after signing', (await engine.listMissingRequirements(id)).inputsMissingSignatures.length);

  const dry = process.env.DRY === '1';
  const json = (x) => JSON.stringify(x, (_, val) => (typeof val === 'bigint' ? val.toString() : val instanceof Uint8Array ? binToHex(val) : val), 2);
  if (dry) {
    const { builtTransaction } = await engine.executeAction(id, { broadcastTransaction: false });
    writeFileSync(here('built.json'), json(builtTransaction));
    console.log('dry run, saved xo/built.json');
    process.exit(0);
  }
  // saved before executing: this engine build can throw while releasing reservations after a successful broadcast
  mkdirSync(here('invitations'), { recursive: true });
  const stored = await engine.getInvitation(id);
  writeFileSync(here(`invitations/claim-set-${net}.json`), JSON.stringify(stored.invitation ?? stored, (_, val) => (typeof val === 'bigint' ? `<bigint: ${val}n>` : val instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(val)}>` : val), 2));
  let txid;
  try {
    txid = (await engine.executeAction(id, { broadcastTransaction: true })).builtTransaction.transactionHash;
  } catch (e) {
    const [now] = await vault.getUtxos(); // the vault coin moves only when a claim confirms into the mempool
    if (now.txid === vaultCoin.txid) throw e;
    console.log(`(engine after broadcast: ${e.name})`);
    txid = now.txid;
  }
  console.log('set claimed via XO', `${explorer}${txid}`);
} finally {
  await engine.stop();
}
