# Jelajah on XO (Build with XO / Migrate to XO bounties)

Jelajah's "buy and stamp" step written as an **XO template**: [`jelajah-stamp.template.json`](jelajah-stamp.template.json), source in [`jelajah-template.mjs`](jelajah-template.mjs).

The template's locking script **assembles to the exact bytes** of Jelajah's `StampMinter` covenant (CashScript 0.14, P2SH32). `buy-stamp.mjs` checks this before every run. So the template doesn't wrap a new contract: it spends the **same live minters** the Jelajah web app uses. That makes it a migration of existing Jelajah functionality to XO, and a novel XO template at the same time.

## What it does
One action, `buyStamp`, for one role, `buyer`.

| # | Input / output | Template entry |
|---|---|---|
| in 0 | the stall's minter coin, holding the rally's minting NFT | `minterInput` (unlocking: `minterUnlockingBytecode` = push of the redeem script) |
| out 0 | minter back to the covenant, unchanged | `minterOutput` → `stampMinter` locking script |
| out 1 | stall price to the stall | `paymentOutput` |
| out 2 | stamp NFT to the buyer, commitment = stall id ‖ buyer pkh | `stampOutput` |
| out 3 | change | engine (`addChangeToInvitation`) |

Like `faucet.cash`, a wallet can't find a stall's minter coin by itself, so `start` is empty and the rally app supplies the minter variables.

## Run it (chipnet)
```bash
cd xo && npm install && cd ..
node xo/buy-stamp.mjs 2          # stall 2 (Bakmi Jawa) on the chipnet rally; funds a throwaway XO account first
DRY=1 node xo/buy-stamp.mjs 2    # build + sign only, write xo/built.json
node xo/verify.mjs               # check built.json against the BCH 2026 VM with real chipnet source outputs
```

## Proof
- Transaction executed through the XO engine (`@xo-cash/engine` 0.1.1-next.18029697917): [`ef106294…`](https://chipnet.imaginary.cash/tx/ef106294af3bd134fad1b7dc02a00ad5402abd306648a39bde67d798ad2c1f00)
- Invitation used: [`invitations/buy-stamp-2-chipnet.json`](invitations/buy-stamp-2-chipnet.json)
- Inspected in the XO debug tool (blaze.xo.cash → Inspect, chipnet): **SUCCESS**; the redeem script shown is the StampMinter covenant. ![blaze.xo.cash inspect](blaze-xo-inspect.png)
- The same minter is spent by the web app (WizardConnect) and by this XO template. Both produce identical stamps.

## Raw engineering notes (facts for the feedback write-up, not the feedback itself)
The bounty asks for personally written feedback, so these are only the facts observed while building:

1. **NFT commitment expressions are decoded as UTF-8.** `resolveTemplateTokenNft` compiles a `$(…)` commitment with `evaluationDecodeMode: "utf8"`, then parses the text as hex. A script that computes raw bytes (`<merchantId> <buyerLockingScript> OP_3 OP_SPLIT …`) produced a garbled 11-byte commitment instead of 21 bytes. Workaround: pass the commitment hex as a `string` variable. The covenant still enforces the real rule on chain.
2. **`listOwnInputIndexes` leaves out contract inputs**, while `listMissingRequirements` still lists the contract input as unsigned. The fix was to pass `unlockingBytecode` on the input in `createInvitation`. Signing it via `signInvitation(0)` fails with `InputUnspentOutputUnavailableError` (not tracked).
3. **Dry runs keep inputs reserved** across process restarts. `archiveInvitation` releases them; without it, the next run fails with a reservation conflict.
4. **Variable typing:** `bytes` / `locking_script` values given as hex strings compile correctly. `token_category` must be a 64-character hex string, not a `Uint8Array`.
5. After a successful broadcast, `engine.stop()` / Electrum threw `blockchain.transaction.subscribe … not the shape the protocol defines` (chipnet Fulcrum). The transaction itself was fine.
6. While debugging, assembling the template's CashASM with libauth and diffing it against CashScript's redeem bytecode was the fastest way to get a byte-exact port.

## Not yet
- A follow-up action for the claim (burn 3 stamps at the `RewardVault`). It needs a template input per stamp and a loop-checked covenant input.
- Mainnet run (the XO bounty itself is judged on chipnet).
