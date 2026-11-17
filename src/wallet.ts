// WizardConnect -> spendable coins + signing for Jelajah transactions.
// The wallet shares xpubs; we derive its first addresses, scan them, and ask it to sign only its own inputs.
import type { DappConnectionManager } from '@wizardconnect/dapp';
import { hash160, encodeLockingBytecodeP2pkh, lockingBytecodeToCashAddress, hexToBin } from '@bitauth/libauth';
import { placeholderP2PKHUnlocker, type TransactionBuilder, type Utxo, type Unlocker } from 'cashscript';
import { provider, rally } from './chain';

const SCAN = 10; // addresses per branch; stamps always go to receive/0
const prefix = rally.network === 'mainnet' ? 'bitcoincash' : 'bchtest';
const BRANCHES = [['receive', 0], ['change', 1]] as const;

export interface Coin { utxo: Utxo; unlocker: Unlocker; path: [string, number] }

export function buyerLock(manager: DappConnectionManager): Uint8Array {
  const pub = manager.getPubkey(0, 0n);
  if (!pub) throw new Error('Wallet did not share its receive key yet');
  return encodeLockingBytecodeP2pkh(hash160(pub));
}

export function addressOf(lock: Uint8Array, tokenSupport = false) {
  const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix, tokenSupport });
  if (typeof r === 'string') throw new Error(r);
  return r.address;
}

export async function walletCoins(manager: DappConnectionManager): Promise<Coin[]> {
  const jobs = BRANCHES.flatMap(([name, child]) => Array.from({ length: SCAN }, async (_, i) => {
    const pub = manager.getPubkey(child, BigInt(i));
    if (!pub) return [];
    const address = addressOf(encodeLockingBytecodeP2pkh(hash160(pub)));
    const utxos = await provider.getUtxos(address);
    return utxos.map((utxo) => ({ utxo, unlocker: placeholderP2PKHUnlocker(address), path: [name, i] as [string, number] }));
  }));
  return (await Promise.all(jobs)).flat();
}

/** Ask the wallet to sign its inputs (input 0 is always the rally contract), then broadcast ourselves. */
export async function signAndSend(manager: DappConnectionManager, builder: TransactionBuilder, inputs: Coin[], userPrompt: string) {
  const transaction = builder.generateWcTransactionObject({ broadcast: false, userPrompt });
  const inputPaths = inputs.map((c, i) => [i + 1, c.path[0], c.path[1]] as [number, string, number]);
  const res = await manager.signTransaction({ transaction: transaction as never, inputPaths });
  if (res.error) throw new Error(res.error);
  return provider.sendRawTransaction(res.signedTransaction);
}

export const explorerTx = (txid: string) =>
  rally.network === 'mainnet' ? `https://blockchair.com/bitcoin-cash/transaction/${txid}` : `https://chipnet.imaginary.cash/tx/${txid}`;

export const lockHex = (hex: string) => hexToBin(hex);
