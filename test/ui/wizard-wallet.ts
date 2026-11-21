// A headless phone wallet for UI tests: it speaks the real WizardConnect protocol (hdwalletv1 over Nostr relays),
// pairs from the wiz:// URI the app shows, shares its xpubs and signs exactly the inputs the app asks for.
// The test clicks the app like a person; this file plays the person's phone. Chipnet only.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  initiateWalletRelay, RelayMsgAction, parseExtendedJsonValue, chunkExtensionAdvertisement, type RelayClient, type SignTransactionRequest,
} from '@wizardconnect/core';
import {
  deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPrivateNodeChild, deriveHdPublicNode, encodeHdPublicKey, decodeTransaction, encodeTransaction,
  hexToBin, binToHex, hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, secp256k1, decodePrivateKeyWif,
  type HdPrivateNodeValid,
} from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';

const SEED_FILE = new URL('./.wallet.chipnet.json', import.meta.url); // gitignored; created on the first run
export const provider = new ElectrumNetworkProvider('chipnet');
const addr = (lock: Uint8Array, tokenSupport = false) => (lockingBytecodeToCashAddress({ bytecode: lock, prefix: 'bchtest', tokenSupport }) as { address: string }).address;
const p2pkh = (priv: Uint8Array) => encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(priv) as Uint8Array));

export class TestWallet {
  private branches: Record<string, HdPrivateNodeValid>;
  private client?: RelayClient;
  private cleanup?: () => void;
  signed: string[] = []; // userPrompt of every request this wallet approved

  constructor() {
    if (!existsSync(SEED_FILE)) writeFileSync(SEED_FILE, JSON.stringify({ seed: randomBytes(32).toString('hex') }));
    const root = deriveHdPrivateNodeFromSeed(hexToBin(JSON.parse(readFileSync(SEED_FILE, 'utf8')).seed), { throwErrors: true }) as HdPrivateNodeValid;
    const node = (p: string) => deriveHdPath(root, p) as HdPrivateNodeValid;
    this.branches = { receive: node("m/44'/145'/0'/0"), change: node("m/44'/145'/0'/1") };
  }

  key(path: string, i: number) { return (deriveHdPrivateNodeChild(this.branches[path], i) as HdPrivateNodeValid).privateKey; }
  address(path = 'receive', i = 0, tokens = false) { return addr(p2pkh(this.key(path, i)), tokens); }
  async balance() { // receive/0 holds the change of every purchase, change/0 the top-ups
    const all = (await Promise.all([this.address('receive', 0), this.address('change', 0)].map((a) => provider.getUtxos(a)))).flat();
    return all.filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  }

  /** Top up change/0 (spending coins, apart from receive/0 where the stamps land) from chipnet keys, in order. */
  async fundFrom(keys: (string | Uint8Array)[], target: bigint) {
    let need = target - await this.balance();
    for (const k of keys) {
      if (need <= 0n) return;
      const priv = typeof k !== 'string' ? k : k.length === 64 ? hexToBin(k) : (decodePrivateKeyWif(k) as { privateKey: Uint8Array }).privateKey;
      const from = addr(p2pkh(priv));
      const utxos = (await provider.getUtxos(from)).filter((u) => !u.token);
      const fee = 300n + 150n * BigInt(utxos.length);
      const total = utxos.reduce((s, u) => s + u.satoshis, 0n) - fee;
      if (total < 1000n) continue;
      const send = total - need >= 1000n ? need : total; // leave change only when it is worth an output
      const b = new TransactionBuilder({ provider }).addInputs(utxos, new SignatureTemplate(priv).unlockP2PKH()).addOutput({ to: this.address('change', 0), amount: send });
      if (send < total) b.addOutput({ to: from, amount: total - send });
      await b.send();
      need -= send;
    }
    if (need > 0n) console.warn(`[test wallet] short by ${need} chipnet sats at ${this.address('change', 0)}; the app will say if it is not enough`);
  }

  /** Pay an address from this wallet's plain coins (what a person does after scanning an address QR). */
  async pay(to: string, amount: bigint) {
    const b = new TransactionBuilder({ provider });
    let total = 0n, n = 0n;
    for (const [path, i] of [['receive', 0], ['change', 0]] as const) {
      const k = this.key(path, i);
      for (const u of (await provider.getUtxos(this.address(path, i))).filter((x) => !x.token)) { b.addInput(u, new SignatureTemplate(k).unlockP2PKH()); total += u.satoshis; n++; }
    }
    const change = total - amount - 300n - 150n * n;
    if (change < 0n) throw new Error(`test wallet holds ${total} sats, cannot pay ${amount}`);
    b.addOutput({ to, amount });
    if (change >= 546n) b.addOutput({ to: this.address('change', 0), amount: change });
    return (await b.send()).txid;
  }

  /** Pair with the dapp from the URI under its QR, the way a phone does after scanning it. */
  connect(uri: string) {
    const walletKey = randomBytes(32);
    const relay = initiateWalletRelay(({ client, status }) => {
      if (status.status !== 'connected' || this.client === client) return;
      this.client = client;
      client.on('message', (m) => this.onMessage(m).catch((e) => console.error('[test wallet]', e)));
      this.hello = (discovered) => this.ready(binToHex(relay.walletPublicKey), relay.secret, discovered);
      void this.hello(false);
    }, { uri, walletPrivateKey: walletKey });
    this.cleanup = relay.cleanup;
  }

  private hello?: (dappDiscovered: boolean) => Promise<void>;
  private ready(publicKey: string, secret: string, dappDiscovered = false) {
    const xpub = (name: string) => ({ name, xpub: encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(this.branches[name]) }).hdPublicKey });
    return this.client!.relay({
      action: RelayMsgAction.WalletReady, time: Math.floor(Date.now() / 1000), wallet_name: 'Jelajah test wallet', wallet_icon: '',
      dapp_discovered: dappDiscovered, supported_protocols: ['hdwalletv1'], public_key: publicKey, secret,
      session: { hdwalletv1: { paths: [xpub('receive'), xpub('change')] } }, extensions: { chunk: chunkExtensionAdvertisement() }, // like Selene: big requests come in chunks
    } as never);
  }

  private async onMessage(m: { action: string }) {
    const now = Math.floor(Date.now() / 1000);
    if (m.action === RelayMsgAction.Ping) return this.client!.relay({ action: RelayMsgAction.Pong, time: now });
    // a dapp page that restored its session (a reload, another page of the app) announces itself: answer like a phone does
    if (m.action === RelayMsgAction.DappReady) return this.hello?.(true);
    if (m.action !== RelayMsgAction.SignTransactionRequest) return;
    console.log('[test wallet] sign request', (m as SignTransactionRequest).sequence);
    const req = m as SignTransactionRequest;
    const wc = req.transaction as unknown as { transaction: string; sourceOutputs: Record<string, unknown>[]; userPrompt?: string };
    const tx = decodeTransaction(hexToBin(wc.transaction));
    if (typeof tx === 'string') throw new Error(tx);
    const sourceOutputs = wc.sourceOutputs.map((o) => fromRelay(o));
    for (const [input, path, i] of req.inputPaths) {
      const unlocker = new SignatureTemplate(this.key(path, i)).unlockP2PKH();
      tx.inputs[input].unlockingBytecode = unlocker.generateUnlockingBytecode({ transaction: tx, sourceOutputs: sourceOutputs as never, inputIndex: input });
    }
    this.signed.push(wc.userPrompt ?? ''); console.log('[test wallet] signed:', wc.userPrompt);
    await this.client!.relay({ action: RelayMsgAction.SignTransactionResponse, time: now, sequence: req.sequence, signedTransaction: binToHex(encodeTransaction(tx)) } as never);
  }

  close() { this.cleanup?.(); this.client = undefined; }
}

// relay JSON -> libauth source output: hex byte fields, "<bigint: Xn>" values, nested token data
const BYTES = new Set(['outpointTransactionHash', 'unlockingBytecode', 'lockingBytecode', 'category', 'commitment']);
function fromRelay(o: unknown, k = ''): unknown {
  if (typeof o === 'string') { const v = parseExtendedJsonValue(o); return v !== o ? v : BYTES.has(k) ? hexToBin(o) : o; }
  if (o && typeof o === 'object' && !(o instanceof Uint8Array)) return Object.fromEntries(Object.entries(o).map(([kk, v]) => [kk, fromRelay(v, kk)]));
  return o;
}
