// Buy a Jelajah stamp through the XO engine (chipnet, or NET=mainnet), then save the invitation for blaze.xo.cash.
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
// NET=mainnet runs against the retired-but-live mainnet rally v1 (same original StampMinter + RewardVault); default chipnet
const net = process.env.NET === 'mainnet' ? 'mainnet' : 'chipnet';
const prefix = net === 'mainnet' ? 'bitcoincash' : 'bchtest';
const explorer = net === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/transaction/' : 'https://chipnet.imaginary.cash/tx/';
const rallyFile = net === 'mainnet' ? '../scripts/rally.mainnet-v1.json' : './rally.chipnet-v1.json';
const rally = JSON.parse(readFileSync(here(rallyFile))); // a rally on the original StampMinter, which the template mirrors
const stall = rally.merchants.find((m) => m.id === stallId);

// throwaway account for the demo, gitignored
const walletFile = here(`.wallet.${net}.json`);
if (!existsSync(walletFile)) writeFileSync(walletFile, JSON.stringify({ mnemonic: generateBip39Mnemonic() }));
const { mnemonic } = JSON.parse(readFileSync(walletFile));

const engine = await Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS[net] });
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
  // the engine syncs headers on start; give it time to see coins it already has before funding it again
  const bch = (l) => l.filter((u) => !u.token);
  const fundedBefore = !!JSON.parse(readFileSync(walletFile)).funded; // never fund twice: wait for the engine to see it instead
  for (let i = 0; i < (fundedBefore ? 150 : 40) && bch(spendable).length === 0 && (fundedBefore || (await engine.listUnspentOutputs()).length > 0); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    spendable = await engine.listSpendableUnspentOutputs();
  }
  spendable = bch(spendable);
  if (spendable.length === 0 && fundedBefore) throw new Error('the engine has not seen the funding yet; run again later');
  if (spendable.length === 0) {
    const receive = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
    const provider = new ElectrumNetworkProvider(net);
    const key = decodePrivateKeyWif(JSON.parse(readFileSync(here(`../scripts/.organizer.${net}.json`))).wif).privateKey;
    const lock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key)));
    const from = lockingBytecodeToCashAddress({ bytecode: lock, prefix }).address;
    const fund = BigInt(process.env.FUND ?? '30000'); // mainnet: just enough for 3 stamps (FUND=10000)
    const [coin] = (await provider.getUtxos(from)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
    const { txid } = await new TransactionBuilder({ provider }).addInput(coin, new SignatureTemplate(key).unlockP2PKH())
      .addOutput({ to: hexToBin(receive), amount: fund })
      .addOutput({ to: lock, amount: coin.satoshis - fund - 1000n }).send();
    console.log('funded XO account', txid);
    writeFileSync(walletFile, JSON.stringify({ ...JSON.parse(readFileSync(walletFile)), funded: txid }));
    for (let i = 0; i < 150 && spendable.length === 0; i++) { await new Promise((r) => setTimeout(r, 2000)); spendable = bch(await engine.listSpendableUnspentOutputs()); }
  }
  // every BCH-only coin of the account (one may be too small for price + fee). The engine's records carry no token data,
  // so token coins (earlier stamps!) are excluded by asking the chain; spending one here would burn it.
  const tokenOutpoints = new Set();
  for (const scriptHash of new Set(spendable.map((u) => u.scriptHash))) {
    const listed = await new ElectrumNetworkProvider(net).performRequest('blockchain.scripthash.listunspent', scriptHash, 'include_tokens');
    listed.filter((u) => u.token_data).forEach((u) => tokenOutpoints.add(`${u.tx_hash}:${u.tx_pos}`));
  }
  // belt and braces: stamps always live at the fixed buyer address
  const savedBuyer = JSON.parse(readFileSync(walletFile)).buyer;
  if (savedBuyer) (await new ElectrumNetworkProvider(net).getUtxos(lockingBytecodeToCashAddress({ bytecode: hexToBin(savedBuyer), prefix }).address))
    .filter((u) => u.token).forEach((u) => tokenOutpoints.add(`${u.txid}:${u.vout}`));
  const hash = (h) => (typeof h === 'string' ? h : binToHex(h));
  const funding = spendable.filter((u) => !tokenOutpoints.has(`${hash(u.outpointTransactionHash)}:${u.outpointIndex}`));
  if (funding.length === 0) throw new Error('no BCH-only coin to pay with');

  const { minters } = rallyContracts(rally, new ElectrumNetworkProvider(net));
  const [minter] = await minters[stallId].getUtxos();
  // one fixed receive address for every stamp: a set must be bought by one key (the default policy rotates addresses)
  const saved = JSON.parse(readFileSync(walletFile));
  if (!saved.buyer) writeFileSync(walletFile, JSON.stringify({ ...saved, buyer: await engine.generateLockingBytecodeFromDefaultPolicy('receive') }));
  const buyerLockingScript = JSON.parse(readFileSync(walletFile)).buyer;
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
      ...funding.map((f) => ({ outpointTransactionHash: hexToBin(f.outpointTransactionHash), outpointIndex: f.outpointIndex })),
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
  console.log('stamped via XO', `${explorer}${builtTransaction.transactionHash}`);
  mkdirSync(here('invitations'), { recursive: true });
  const out = here(`invitations/buy-stamp-${stallId}-${net}.json`);
  writeFileSync(out, JSON.stringify(storedInvitation.invitation, (_, v) => (typeof v === 'bigint' ? `<bigint: ${v}n>` : v instanceof Uint8Array ? `<Uint8Array: 0x${binToHex(v)}>` : v), 2));
  console.log('invitation saved for blaze.xo.cash ->', out.pathname);
} finally {
  await engine.stop();
}
