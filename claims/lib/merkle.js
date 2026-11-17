// Fixed-depth sha256d Merkle trees matching ClaimPool.cash. Sparse: only real leaves are stored,
// empty subtrees use precomputed zero hashes, so a depth-16 tree with a few hundred leaves is cheap.
import { sha256, binToHex, hexToBin, flattenBinArray } from '@bitauth/libauth';

export const hash256 = (b) => sha256.hash(sha256.hash(b));

/** int -> 8-byte little-endian, as CashScript's toPaddedBytes(x, 8) for 0 <= x < 2^55 */
export function le8(n) {
  const v = BigInt(n);
  if (v < 0n || v >= 2n ** 55n) throw new Error(`amount out of range: ${n}`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return out;
}

export const earnedLeaf = (pkh, cumulative) => hash256(flattenBinArray([pkh, le8(cumulative)]));
export const claimedLeaf = (claimed) => hash256(le8(claimed));
export const EMPTY_EARNED = earnedLeaf(new Uint8Array(20), 0);
export const EMPTY_CLAIMED = claimedLeaf(0);

export class Tree {
  /** @param {number} depth  @param {Uint8Array} empty leaf used for every unset index */
  constructor(depth, empty) {
    this.depth = depth;
    this.zero = [empty];
    for (let i = 0; i < depth; i++) this.zero.push(hash256(flattenBinArray([this.zero[i], this.zero[i]])));
    this.levels = Array.from({ length: depth + 1 }, () => new Map());
  }
  node(level, i) { return this.levels[level].get(i) ?? this.zero[level]; }
  set(index, leaf) {
    if (index < 0 || index >= 2 ** this.depth) throw new Error(`index ${index} out of range`);
    this.levels[0].set(index, leaf);
    let i = index;
    for (let l = 0; l < this.depth; l++) {
      const left = i % 2 === 0 ? this.node(l, i) : this.node(l, i - 1);
      const right = i % 2 === 0 ? this.node(l, i + 1) : this.node(l, i);
      i = Math.floor(i / 2);
      this.levels[l + 1].set(i, hash256(flattenBinArray([left, right])));
    }
  }
  root() { return this.node(this.depth, 0); }
  /** siblings bottom-up, concatenated: what ClaimPool.claim() takes as a proof */
  proof(index) {
    const out = [];
    let i = index;
    for (let l = 0; l < this.depth; l++) { out.push(this.node(l, i ^ 1)); i = Math.floor(i / 2); }
    return flattenBinArray(out);
  }
}

/** Both trees for a distribution: entries [{ index, pkh(hex), cumulative }], claimed { [index]: amount } */
export function buildTrees(depth, entries, claimed = {}) {
  const earned = new Tree(depth, EMPTY_EARNED);
  const claimedTree = new Tree(depth, EMPTY_CLAIMED);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.pkh)) throw new Error(`duplicate pkh ${e.pkh}: one leaf per folder`);
    seen.add(e.pkh);
    earned.set(e.index, earnedLeaf(hexToBin(e.pkh), e.cumulative));
  }
  for (const [i, c] of Object.entries(claimed)) if (BigInt(c) > 0n) claimedTree.set(Number(i), claimedLeaf(c));
  return { earned, claimed: claimedTree };
}

/** keeper commitment: earnedRoot[32] ‖ claimedRoot[32] ‖ epoch[4 LE] */
export const rootsCommitment = (earnedRoot, claimedRoot, epoch = 0) => binToHex(flattenBinArray([earnedRoot, claimedRoot, le4(epoch)]));
/** proposal commitment: newEarnedRoot[32] ‖ epoch[4 LE] */
export const proposalCommitment = (root, epoch) => binToHex(flattenBinArray([root, le4(epoch)]));
export function le4(n) {
  if (n < 0 || n >= 2 ** 31) throw new Error(`epoch out of range: ${n}`);
  return Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255);
}
export const epochOf = (commitmentHex) => { const b = hexToBin(commitmentHex.slice(128)); return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24); };
