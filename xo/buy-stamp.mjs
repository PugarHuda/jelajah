// Buy a Jelajah stamp through the XO engine on chipnet, then save the invitation for blaze.xo.cash.
//   node xo/buy-stamp.mjs [stallId]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Engine, XO_SUPPORTED_NETWORKS, DUST_LIMIT_SATOSHIS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { assembleBytecodeBCH, encodeDataPush, generateBip39Mnemonic, hexToBin, binToHex, lockingBytecodeToCashAddress, decodePrivateKeyWif, secp256k1, hash160, encodeLockingBytecodeP2pkh } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { jelajahStampTemplate } from './jelajah-template.mjs';
import { rallyContracts } from '../src/lib/tx.js';

const here = (p) => new URL(p, import.meta.url);
const stallId = Number(process.argv[2] ?? 2);
const rally = JSON.parse(readFileSync(here('../src/rally.chipnet.json')));
const stall = rally.merchants.find((m) => m.id === stallId);

// throwaway chipnet account for the demo, gitignored
const walletFile = here('.wallet.chipnet.json');
if (!existsSync(walletFile)) writeFileSync(walletFile, JSON.stringify({ mnemonic: generateBip39Mnemonic() }));
const { mnemonic } = JSON.parse(readFileSync(walletFile));

const engine = await Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS.chipnet });
try {
  const p2pkh = await engine.importTemplate(p2pkhTemplate);
  await engine.setDefaultPolicies({
    change: { templateIdentifier: p2pkh.templateIdentifier },
    receive: { templateIdentifier: p2pkh.templateIdentifier },
    address: { templateIdentifier: p2pkh.templateIdentifier },
  });
  const { templateIdentifier } = await engine.importTemplate(jelajahStampTemplate);
  console.log('template', templateIdentifier);

  // drop leftovers from earlier dry runs: they keep their inputs reserved
  for (const inv of await engine.listInvitations()) {
    const iid = inv.invitation?.invitationIdentifier ?? inv.invitationIdentifier;
    if (iid) await engine.archiveInvitation(iid).catch(() => {});
  }

  // fund the XO account from the rally organizer if it is empty
  let spendable = await engine.listSpendableUnspentOutputs();
  if (spendable.length === 0) {
    const receive = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
    const provider = new ElectrumNetworkProvider('chipnet');
    const key = decodePrivateKeyWif(JSON.parse(readFileSync(here('../scripts/.organizer.chipnet.json'))).wif).privateKey;
    const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key)));
    const from = lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest' }).address;
    const [coin] = (await provider.getUtxos(from)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
    const { txid } = await new TransactionBuilder({ provider }).addInput(coin, new SignatureTemplate(key).unlockP2PKH())
      .addOutput({ to: hexToBin(receive), amount: 30_000n })
      .addOutput({ to: lock, amount: coin.satoshis - 31_000n }).send();
    console.log('funded XO account', txid);
    for (let i = 0; i < 30 && spendable.length === 0; i++) { await new Promise((r) => setTimeout(r, 2000)); spendable = await engine.listSpendableUnspentOutputs(); }
  }
  const funding = spendable.sort((a, b) => Number(BigInt(b.valueSatoshis) - BigInt(a.valueSatoshis)))[0];

  const { minters } = rallyContracts(rally, new ElectrumNetworkProvider('chipnet'));
  const [minter] = await minters[stallId].getUtxos();
  const buyerLockingScript = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
  // same CashASM as the template's minterRedeemBytecode, with this stall's values
  const minterUnlocking = () => {
    const asm = jelajahStampTemplate.scripts.minterRedeemBytecode
      .replace('<merchantId>', `<0x${stallId.toString(16).padStart(2, '0')}>`)
      .replace('<stallPrice>', `<${stall.price}>`)
      .replace('<stallLockingScript>', `<0x${stall.lock}>`);
    const r = assembleBytecodeBCH(asm);
    if (!r.success) throw new Error(JSON.stringify(r.errors));
    if (binToHex(r.bytecode) !== minters[stallId].bytecode) throw new Error('template redeem script differs from the live minter');
    return encodeDataPush(r.bytecode);
  };

  const created = await engine.createInvitation({
    templateIdentifier,
    actionIdentifier: 'buyStamp',
    roleIdentifier: 'buyer',
    variables: [
      { variableIdentifier: 'merchantId', roleIdentifier: 'buyer', value: stallId.toString(16).padStart(2, '0') },
      { variableIdentifier: 'stallPrice', roleIdentifier: 'buyer', value: BigInt(stall.price) },
      { variableIdentifier: 'stallLockingScript', roleIdentifier: 'buyer', value: stall.lock },
      { variableIdentifier: 'stampCategory', roleIdentifier: 'buyer', value: rally.category },
      { variableIdentifier: 'minterSatoshis', roleIdentifier: 'buyer', value: minter.satoshis },
      { variableIdentifier: 'buyerLockingScript', roleIdentifier: 'buyer', value: buyerLockingScript },
      { variableIdentifier: 'stampCommitmentHex', roleIdentifier: 'buyer', value: stallId.toString(16).padStart(2, '0') + buyerLockingScript.slice(6, 46) },
    ],
    inputs: [
      // the covenant needs no signature: its unlocking bytecode is just the redeem script (template: minterUnlockingBytecode)
      { outpointTransactionHash: hexToBin(minter.txid), outpointIndex: minter.vout, inputIdentifier: 'minterInput', unlockingBytecode: minterUnlocking() },
      { outpointTransactionHash: hexToBin(funding.outpointTransactionHash), outpointIndex: funding.outpointIndex },
    ],
  });
  const id = created.invitation.invitationIdentifier;
  await engine.appendInvitation(id, {
    templateIdentifier,
    actionIdentifier: 'buyStamp',
    outputs: [{ outputIdentifier: 'minterOutput' }, { outputIdentifier: 'paymentOutput' }, { outputIdentifier: 'stampOutput' }],
  });

  const missing = await engine.listMissingRequirements(id);
  console.log('missing before signing', JSON.stringify(missing, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

  const leftover = await engine.calculateChange(id);
  const fee = await engine.estimateTransactionFee(id);
  if (leftover.valueSatoshis - BigInt(fee) >= BigInt(DUST_LIMIT_SATOSHIS)) await engine.addChangeToInvitation(id);
  for (const i of await engine.listOwnInputIndexes(id)) await engine.signInvitation(id, i);
  const still = await engine.listMissingRequirements(id);
  console.log('unsigned after signing', still.inputsMissingSignatures.length);

  const dry = process.env.DRY === '1';
  const { builtTransaction, storedInvitation } = await engine.executeAction(id, { broadcastTransaction: !dry });
  if (dry) { writeFileSync(here('built.json'), JSON.stringify(builtTransaction, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? binToHex(v) : v), 2)); console.log('dry run, saved xo/built.json'); process.exit(0); }
  console.log('stamped via XO', `https://chipnet.imaginary.cash/tx/${builtTransaction.transactionHash}`);
  mkdirSync(here('invitations'), { recursive: true });
  const out = here(`invitations/buy-stamp-${stallId}-chipnet.json`);
  writeFileSync(out, JSON.stringify(storedInvitation.invitation, (_, v) => (typeof v === 'bigint' ? `<bigint: ${v}n>` : v instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(v)}>` : v), 2));
  console.log('invitation saved for blaze.xo.cash ->', out.pathname);
} finally {
  await engine.stop();
}
