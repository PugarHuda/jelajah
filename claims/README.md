# Pull-based Merkle reward claims (FoldingCash bounty, BCH BLAZE 2026)

This replaces FoldingCash's trusted monthly token pushes with claims any folder can make whenever they like.

- **The operator** publishes one Merkle root per epoch.
- **A folder** withdraws everything they've earned but not yet claimed, with a proof.
- **The cost to the operator** is the same whether there are 62 folders or 10,000.

The code is in [`claims/`](.), part of the Jelajah repo. It runs on **real FoldingCash distro data**: October 2026 (62 folders) and 1–16 November 2026 (54 folders), both from `api.folding.cash/v1/GetDistro`.

## The idea in one paragraph

There are two Merkle trees with the **same leaf indices**:

| Tree | Leaf | Who updates it |
|---|---|---|
| earned | `hash256(pkh ‖ cumulativeEarned[8 LE])` | the operator, once per epoch (cumulative, append-only indices) |
| claimed | `hash256(claimedSoFar[8 LE])` | **every claim, on chain** |

Both roots live in one mutable NFT (the *keeper*): `earnedRoot ‖ claimedRoot ‖ epoch`.

A claim proves a folder's earned leaf and their claimed leaf at the same index. It is paid `cumulative − claimedSoFar`, and it writes the new claimed root. The pool covenant checks all of this in one transaction.

### Why not just a receipt NFT?

The bounty suggests "a per-user receipt NFT created at first claim". On its own, that can't stop a double claim.

BCH has no global state, so the contract can't tell "this person never claimed" apart from "this person is hiding their receipt". A folder who leaves their receipt out of the transaction looks exactly like a first-time claimer, and would be paid their whole cumulative total again.

Proving the claimed leaf against an on-chain root closes this hole. `test/check.mjs` builds exactly that attack by hand, and the contract rejects it (`ClaimPool.cash:51`).

## Contracts (CashScript 0.14, `contracts/`)

| Contract | Size | Job |
|---|---|---|
| `ClaimPool.cash` | 413 B | Holds the reward tokens. `claim()` verifies both proofs (a 16-level loop), pays exactly the difference to `P2PKH(pkh)`, and updates the claimed root. `topUp()` lets anyone add tokens. |
| `RootKeeper.cash` | 134 B | Holds **the** mutable NFT of its category. That category is created **without a minting authority**, so no second keeper can ever exist, not even one made by the operator. |
| `RootProposal.cash` | 30 B | A new earned root waits here as an NFT of a separate *proposal* category, for `delay` blocks (CSV). The operator can `cancel()` a bad one before it matures. |

### Threat model

Every "rejected" row below is a test that hand-builds the attack transaction and checks that the contract refuses it.

| Attack | Result |
|---|---|
| Hide a previous claim and claim again | ❌ claimed-leaf proof fails |
| Claim an amount that isn't in the earned root | ❌ earned-leaf proof fails |
| Submit someone's claim but pay yourself | ❌ payout must go to `P2PKH(pkh)` of the leaf |
| Mint a fake keeper with forged roots | ❌ keeper category must match; that category can't mint |
| Hijack the keeper next to `topUp()` | ❌ `topUp` refuses any transaction that carries the keeper |
| Send junk tokens to the pool address, then "pay" a victim's claim out of them | ❌ pool only pays out of the reward category |
| Activate a root before its delay | ❌ CSV |
| Roll back to an older root (out-of-order activation) | ❌ epoch must strictly increase |

**Still trusted**, as the bounty states:
- the F@H daily stats file;
- FoldingCash's inclusion rules;
- the root the operator publishes.

The timelock and the watcher (`sync`) are there so that a bad root is visible before it matters, and the operator can cancel it.

## Run it

```bash
npm install
npm run claims:check                               # 13 checks, every tx validated against the BCH VM (mock network)
node claims/cost.mjs                               # push vs pull cost table
node claims/cli.mjs setup    --network chipnet     # geneses + 300-leaf tree (62 real October folders + 2 demo claimers + filler)
node claims/cli.mjs claim    --network chipnet --who demo1
node claims/cli.mjs sync     --network chipnet     # replay every claim from the chain and check it rebuilds the keeper's claimed root
node claims/cli.mjs propose  --network chipnet --distro claims/data/fldch-distro-2026-11.json
node claims/cli.mjs activate --network chipnet     # after `delay` blocks
```

`claim` can be sent by anyone on a folder's behalf, because the tokens can only go to the folder. That makes the **auto-claim relayer** stretch goal a non-custodial script with no special rights.

## Mainnet run (21 Nov 2026)

The same lifecycle on **BCH mainnet** (test FLDCH token, real October + November FoldingCash folders in the tree):
- Proposal authority genesis [`7b0afe05…`](https://blockchair.com/bitcoin-cash/transaction/7b0afe05c207cd3b8027efc2b3316b227f131287aabeea08474d5ca3b2414071) · test FLDCH genesis [`ef77d43e…`](https://blockchair.com/bitcoin-cash/transaction/ef77d43ec8ab7be7fe34d68b95ec6fc216412ebf0b1cb358ba26c6ba9841ba1d) · keeper NFT genesis [`35165a92…`](https://blockchair.com/bitcoin-cash/transaction/35165a9273fb23b06ab27111ec655fc6a0d536dea05487ceee5797393f80a526)
- Pool funded with 300 leaves: [`c4d2eb5c…`](https://blockchair.com/bitcoin-cash/transaction/c4d2eb5c38ebd0f66516c135658bdb68512e1e8dd473124b320be4c5cfb7574e)
- Claim against the October root (2,361 bytes, depth-16 proofs): [`cb2e5a51…`](https://blockchair.com/bitcoin-cash/transaction/cb2e5a51488c88e4f78d1afc9229efd10ba6d044da8c2ea1347439fcb1bf6df8)
- Epoch 1 (November data) proposed [`5eeb0e23…`](https://blockchair.com/bitcoin-cash/transaction/5eeb0e239738692b3e7186b0dc42ad1ae06b667b62cbd9727a61e77e2afeb71d), activated after the 2-block CSV delay [`c7b58ccf…`](https://blockchair.com/bitcoin-cash/transaction/c7b58ccf310ed3659760d657590f5e5e56191dde18b41c8b1e43420fedd47b8f) (an earlier attempt was refused by mainnet nodes: `non-BIP68-final`)
- Claim against the new root: [`aebb5f33…`](https://blockchair.com/bitcoin-cash/transaction/aebb5f332e1acf52f04f01cd9fad7005966465476e0c634ca022d1761ee5891a). A claimer with nothing new in the November tree is refused locally (`nothing to claim`), and the covenant would refuse it too.
- `sync` replayed both claims from mainnet, and the rebuilt claimed root **matches** the keeper. State: [`state.mainnet.json`](state.mainnet.json).

## Chipnet run (17 Nov 2026)

- Proposal authority genesis: [`49bd559d…`](https://chipnet.imaginary.cash/tx/49bd559d26986318683d56e974ddbf03cf1847ac02eeefc3cdb9ee6a13ddd7ae)
- Test FLDCH genesis: [`0bd322b3…`](https://chipnet.imaginary.cash/tx/0bd322b310cc59f15624813524629b232a98873fb2a0d16ddd5cff7da6ee10fc)
- Keeper NFT genesis (no minting authority): [`f7ea47b5…`](https://chipnet.imaginary.cash/tx/f7ea47b5d9f88da601ddd9ae9e5ce8bfacca04f4442cae388ed5321a4785cf45)
- Pool funded with 300 leaves: [`36e6c85c…`](https://chipnet.imaginary.cash/tx/36e6c85c6f26f6069d000b0ef30404714b83322b3f7468f783a680c6670080c6)
- Claims (2,361 bytes each, depth-16 proofs, accepted by chipnet nodes): [`48cb57ed…`](https://chipnet.imaginary.cash/tx/48cb57ed89cf741242aaccc97127bad10638a978d1db9006a2af1f6d2f16ce34), [`34e0896c…`](https://chipnet.imaginary.cash/tx/34e0896ceb5cb8d64dc44b054e94613212ba909ef95925526c6bf4cadc6a465e)
- `sync` replayed both claims from the chain, and the rebuilt claimed root **matches** the keeper.
- Epoch 1 proposal, using real November data: [`7299e9c0…`](https://chipnet.imaginary.cash/tx/7299e9c0dd71d2c12b822e9e3c465383ec368a1d5e0be1a9c455dcf00a7b5a8e)
- Epoch 1 activated after the 2-block CSV delay (enforced by chipnet consensus): [`f2ecd0fe…`](https://chipnet.imaginary.cash/tx/f2ecd0fe4e6aff8d5ffd29072c21636b0e514af304aaea0c444378a21ece788e). The claimed totals carried over, and `sync` still rebuilds a root that **matches** the keeper.

## Cost: push vs pull (`node claims/cost.mjs`, 1 sat/byte)

| Folders | Push, operator pays per month | Pull, operator pays per epoch | Pull, a folder pays per claim (any time) |
|---|---|---|---|
| 62 (Oct 2026) | 45,792 sats | ~1,000 sats | ~3,000 sats |
| 300 | 220,960 sats | ~1,000 sats | ~3,000 sats |
| 10,000 | 7,360,160 sats | ~1,000 sats | ~3,000 sats |

The operator's cost stops growing with the number of folders. A folder pays one claim whenever they choose: monthly, yearly, or never for dust they don't care about. Push pays every folder's dust every month.

## Answers to the bounty's open questions

- **Epoch cadence:** anything. Roots are cumulative, so a folder can skip epochs and claim the sum later. Daily roots cost the same per root as monthly ones.
- **Scale:** depth 16 holds 65,536 folders with two 512-byte proofs. Depth 20 (a million folders) needs two 640-byte proofs, still well inside the 10 KB unlocking limit.
- **Root authority:** the proposal minting NFT sits in the operator's wallet. Moving it to a multisig P2SH gives threshold updates without touching the contracts.
- **Receipt NFT:** not needed. The claimed tree is the receipt, and it can't be hidden.
- **Leaf contents:** `pkh ‖ cumulative`. A linking-method flag could be added to the leaf so a watcher knows which entries it can verify from public F@H data.
- **Legacy BTC addresses:** a BTC P2PKH address has the same hash160 as the BCH address for the same key. 61 of the 62 October folders use BTC addresses, and they map straight to claimable leaves with no extra linking step (`lib/distro.js`).

## Known limits

- Claims go one after another, because each one updates the keeper. Concurrent claimers retry against the newest root, and `sync` rebuilds it from the chain. The proof server is the natural place to queue claims.
- Indices are append-only. If a folder's address changes, they get a new leaf.
