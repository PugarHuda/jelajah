// Send the XO demo account's BCH (never its token coins: stamps, trophies) back to the rally organizer.
//   NET=mainnet DRY=1 node xo/sweep.mjs && NET=mainnet node xo/verify.mjs && NET=mainnet node xo/sweep.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { hexToBin, binToHex, decodePrivateKeyWif, secp256k1, hash160, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';

const net = process.env.NET === 'mainnet' ? 'mainnet' : 'chipnet';
const here = (p) => new URL(p, import.meta.url);
const { mnemonic } = JSON.parse(readFileSync(here(`.wallet.${net}.json`)));
const key = decodePrivateKeyWif(JSON.parse(readFileSync(here(`../scripts/.organizer.${net}.json`))).wif).privateKey;
const organizer = binToHex(encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key))));
const provider = new ElectrumNetworkProvider(net);
const hash = (h) => (typeof h === 'string' ? h : binToHex(h));

const engine = await Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS[net] });
try {
  const p2pkh = await engine.importTemplate(p2pkhTemplate);
  await engine.setDefaultPolicies({ change: { templateIdentifier: p2pkh.templateIdentifier }, receive: { templateIdentifier: p2pkh.templateIdentifier }, address: { templateIdentifier: p2pkh.templateIdentifier } });
  for (const inv of await engine.listInvitations()) {
    const iid = inv.invitation?.invitationIdentifier ?? inv.invitationIdentifier;
    if (iid) await engine.archiveInvitation(iid).catch(() => {});
  }
  let spendable = await engine.listSpendableUnspentOutputs();
  for (let i = 0; i < 100 && spendable.length === 0; i++) { await new Promise((r) => setTimeout(r, 3000)); spendable = await engine.listSpendableUnspentOutputs(); }
  // the engine's records carry no token data: ask Electrum which outpoints hold tokens and keep those out
  const tokenOutpoints = new Set();
  for (const scriptHash of new Set(spendable.map((u) => u.scriptHash))) {
    const listed = await provider.performRequest('blockchain.scripthash.listunspent', scriptHash, 'include_tokens');
    listed.filter((u) => u.token_data).forEach((u) => tokenOutpoints.add(`${u.tx_hash}:${u.tx_pos}`));
  }
  const coins = spendable.filter((u) => !tokenOutpoints.has(`${hash(u.outpointTransactionHash)}:${u.outpointIndex}`));
  const total = coins.reduce((s, u) => s + BigInt(u.valueSatoshis), 0n);
  console.log(`${coins.length} BCH coins, ${total} sats (${spendable.length - coins.length} token coins left alone)`);
  if (total < 1500n) throw new Error('nothing worth sweeping');
  const fee = 250n + 150n * BigInt(coins.length);
  const created = await engine.createInvitation({
    templateIdentifier: p2pkh.templateIdentifier,
    actionIdentifier: 'sendSatoshis',
    roleIdentifier: 'sender',
    variables: [
      { variableIdentifier: 'transferredSatoshis', roleIdentifier: 'sender', value: total - fee },
      { variableIdentifier: 'recipientLockingscript', roleIdentifier: 'sender', value: organizer },
    ],
    inputs: coins.map((u) => ({ outpointTransactionHash: hexToBin(hash(u.outpointTransactionHash)), outpointIndex: u.outpointIndex })),
  });
  const id = created.invitation.invitationIdentifier;
  await engine.appendInvitation(id, { templateIdentifier: p2pkh.templateIdentifier, actionIdentifier: 'sendSatoshis', outputs: [{ outputIdentifier: 'transferSatoshisOutput' }] });
  for (const i of await engine.listOwnInputIndexes(id)) await engine.signInvitation(id, i);
  const dry = process.env.DRY === '1';
  const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? binToHex(v) : v), 2);
  if (dry) {
    writeFileSync(here('built.json'), json((await engine.executeAction(id, { broadcastTransaction: false })).builtTransaction));
    console.log('dry run, saved xo/built.json');
  } else {
    const { builtTransaction } = await engine.executeAction(id, { broadcastTransaction: true }).catch((e) => { console.log('(engine after broadcast:', e.name, ')'); return { builtTransaction: {} }; });
    console.log('swept to the organizer', builtTransaction.transactionHash ?? '(check the organizer balance)');
  }
} finally {
  await engine.stop().catch(() => {});
  process.exit(0);
}
