// FoldingCash GetDistro responses -> cumulative Merkle entries.
// Indices are append-only: an address keeps its index forever, new folders get the next free one,
// so each new root only ever grows a leaf's cumulative total (the claimed tree stays aligned).
import { binToHex, decodeBase58Address, decodeCashAddress } from '@bitauth/libauth';

export const FLDCH_DECIMALS = 8;

/** Any address FoldingCash hands out -> 20-byte P2PKH hash (hex). Legacy BTC P2PKH keys spend the same pkh on BCH. */
export function pkhOf(user) {
  const cash = user.cashTokensAddress ?? user.bitcoinCashAddress;
  if (cash) {
    const d = decodeCashAddress(cash.includes(':') ? cash : `bitcoincash:${cash}`);
    if (typeof d === 'string' || !['p2pkh', 'p2pkhWithTokens'].includes(d.type)) return null;
    return binToHex(d.payload);
  }
  if (user.bitcoinAddress) {
    const d = decodeBase58Address(user.bitcoinAddress);
    if (typeof d === 'string' || d.version !== 0) return null; // P2PKH only
    return binToHex(d.payload);
  }
  return null;
}

/** Fold one month's distro into the running totals. prev: { depth, entries } or undefined */
export function addEpoch(prev, distroResponse, depth = 16) {
  const entries = (prev?.entries ?? []).map((e) => ({ ...e }));
  const byPkh = new Map(entries.map((e) => [e.pkh, e]));
  const skipped = [];
  for (const user of distroResponse.distro) {
    const pkh = pkhOf(user);
    if (!pkh) { skipped.push(user); continue; }
    const units = BigInt(Math.round(user.amount * 10 ** FLDCH_DECIMALS));
    const e = byPkh.get(pkh) ?? { index: entries.length, pkh, cumulative: '0' };
    if (!byPkh.has(pkh)) { entries.push(e); byPkh.set(pkh, e); }
    e.cumulative = (BigInt(e.cumulative) + units).toString();
  }
  if (entries.length > 2 ** depth) throw new Error('tree full: raise depth');
  return { depth, entries, skipped };
}
