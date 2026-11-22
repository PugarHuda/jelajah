// "Watch a full set": decode the real mainnet transactions of one levy cycle, live from the chain, and say what each did.
// Nothing here is written by hand: amounts, stalls, stamps and the pool balance all come from the raw transactions and
// the rally's own contract addresses.
import { decodeTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import type { Rally } from '../chain';

type Out = { sats: bigint; lock: string; nft?: { commitment: string; capability: string } };
export type Step =
  | { kind: 'stamp'; txid: string; stall: string; emoji: string; toStall: bigint; levy: bigint; buyer: string; minterBack: boolean }
  | { kind: 'merge'; txid: string; before: bigint; levies: bigint[]; after: bigint }
  | { kind: 'claim'; txid: string; before: bigint; after: bigint; burned: string[]; trophyTo: string };

const lockOf = (address: string) => {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(r);
  return binToHex(r.bytecode);
};
const pkhOf = (lock: string) => (lock.startsWith('76a914') ? lock.slice(6, 46) : '');

export async function loadCycle(o: { provider: NetworkProvider; rally: Rally; vaultAddress: string; minterAddresses: string[]; stamps: string[]; merge: string; claim: string }): Promise<Step[]> {
  const cache = new Map<string, ReturnType<typeof decode>>();
  const decode = (hex: string) => {
    const tx = decodeTransaction(hexToBin(hex));
    if (typeof tx === 'string') throw new Error(tx);
    return {
      inputs: tx.inputs.map((i) => ({ txid: binToHex(i.outpointTransactionHash), vout: i.outpointIndex })),
      outputs: tx.outputs.map((x): Out => ({ sats: x.valueSatoshis, lock: binToHex(x.lockingBytecode), nft: x.token?.nft && { commitment: binToHex(x.token.nft.commitment), capability: x.token.nft.capability } })),
    };
  };
  const tx = async (id: string) => {
    if (!cache.has(id)) cache.set(id, decode(await o.provider.getRawTransaction(id)));
    return cache.get(id)!;
  };
  const prevOut = async (i: { txid: string; vout: number }) => (await tx(i.txid)).outputs[i.vout];
  const vault = lockOf(o.vaultAddress);
  const minters = new Set(o.minterAddresses.map(lockOf));
  const steps: Step[] = [];

  for (const id of o.stamps) {
    const t = await tx(id);
    const stamp = t.outputs.find((x) => x.nft && x.nft.capability === 'none' && x.nft.commitment.length >= 42 && x.nft.commitment.slice(0, 2) !== '00');
    if (!stamp) throw new Error(`${id.slice(0, 8)} mints no stamp`);
    const m = o.rally.merchants.find((x) => x.id === parseInt(stamp.nft!.commitment.slice(0, 2), 16))!;
    steps.push({
      kind: 'stamp', txid: id, stall: m.name, emoji: m.emoji,
      // the stall's payment: the first plain output to the stall's address (a buyer's change can share it in a demo)
      toStall: t.outputs.find((x) => !x.nft && x.lock === m.lock)?.sats ?? 0n,
      levy: t.outputs.filter((x) => x.lock === vault && !x.nft).reduce((s, x) => s + x.sats, 0n),
      buyer: stamp.nft!.commitment.slice(2, 42),
      minterBack: t.outputs.some((x) => minters.has(x.lock) && x.nft?.capability === 'minting'),
    });
  }

  const merge = await tx(o.merge);
  const mergeIns = await Promise.all(merge.inputs.map(prevOut));
  steps.push({
    kind: 'merge', txid: o.merge,
    before: mergeIns.filter((x) => x.lock === vault && x.nft).reduce((s, x) => s + x.sats, 0n),
    levies: mergeIns.filter((x) => x.lock === vault && !x.nft).map((x) => x.sats),
    after: merge.outputs.filter((x) => x.lock === vault).reduce((s, x) => s + x.sats, 0n),
  });

  const claim = await tx(o.claim);
  const claimIns = await Promise.all(claim.inputs.map(prevOut));
  const trophy = claim.outputs.find((x) => x.nft?.commitment.startsWith('00') && x.nft.capability === 'none');
  steps.push({
    kind: 'claim', txid: o.claim,
    before: claimIns.filter((x) => x.lock === vault).reduce((s, x) => s + x.sats, 0n),
    after: claim.outputs.filter((x) => x.lock === vault).reduce((s, x) => s + x.sats, 0n),
    burned: claimIns.filter((x) => x.nft && x.nft.capability === 'none' && x.nft.commitment.slice(0, 2) !== '00')
      .map((x) => o.rally.merchants.find((m) => m.id === parseInt(x.nft!.commitment.slice(0, 2), 16))?.name ?? '?'),
    trophyTo: trophy ? trophy.nft!.commitment.slice(2, 42) : pkhOf(''),
  });
  return steps;
}
