# DoraHacks BUIDL: BCH BLAZE 2026 submission text

**Name:** Jelajah

**One-liner (Vision field):** A stamp rally on Bitcoin Cash: pay a stall, get its stamp NFT in the same transaction, burn a set of 3 to get paid back.

**Links**
- Live demo: https://jelajah-bch.vercel.app
- Code: https://github.com/PugarHuda/jelajah
- Deck (Widget Factory template): https://jelajah-bch.vercel.app/deck.pdf
- CashTokens address (EMBER2026 votes / prizes): bitcoincash:zrd56cv5ap5v2kc2dgc8hvt4e9g84pmrjcydclcrgj

**Tracks:** Mainnet Track
**Bounties:** FoldingCash Reward Claims (`claims/`) · Build with XO + Migrate to XO (`xo/`)

**Prior work:** none. Built from scratch during BLAZE; first commit 17 Nov 2026.

---

## Description

Food festivals and malls in Jogja run stamp cards: eat at five stalls and win a prize. The cards are paper, easy to fake, and the prize depends on the organiser keeping their word. **Jelajah** moves this on chain.

**How it works**
1. **Pay a stall** with any WizardConnect wallet (Selene, Paytaca, Cashonize). The stall's covenant only lets its stamp NFT out if the stall was paid at least its price, in the same transaction.
2. **Collect stamps** from 3 different stalls. Each stamp carries the buyer's key hash, so stamps can be traded as collectibles, but only the real buyer can claim with them.
3. **Burn the set.** The reward vault loops over the stamps (using the 2026 VM loops), checks they come from 3 different stalls and were all bought by you, then pays you back and mints a **Trophy** NFT.

There is no sign-up, no server and no database. The prize is locked in a covenant, so the organiser can't take it back before the rally ends.

**For the judges, under 2 minutes:** open the demo, connect, buy at 3 stalls (2,000 sats each), then claim.

**Why it's a business:** organisers, malls and brands pay per rally, and every stamp is a paid visit they can prove. The anti-farming rule (reward < cheapest full set) means a stall can never profit from buying its own stamps.

**Tech:** CashScript 0.14 (StampMinter 94 B, RewardVault 170 B), CashTokens, WizardConnect, React/Vite. The test suite runs every transaction against the BCH VM, including the attack cases. Tested end to end with Selene on chipnet. Run end to end on mainnet with the first rally: 3 stamps, then claim + trophy [`0e071a46…`](https://blockchair.com/bitcoin-cash/transaction/0e071a4648f8ac6ab48bf97f48e72ff473dfd5af3fa3bc6a131e5974ab528b33). The live demo is rally v2 on mainnet (genesis [`4c96cba2…`](https://blockchair.com/bitcoin-cash/transaction/4c96cba232afc690f841ffa7b4e10680de7b3123df4836da50700fa208a2601d), first v2 stamp [`8b3d8dec…`](https://blockchair.com/bitcoin-cash/transaction/8b3d8deccc37c42ec9e8850dc6483591ee524e5d4c672d89e04eb579ee5bd596)). The organizer page and proof of presence were also tested with Selene over WizardConnect on chipnet.

**New in v2: your trophy is a membership card.** `StampMinter2` charges a member price when you show your own trophy, and the covenant forces the trophy straight back to you in the same transaction. Each stall also gets 2 minter "lanes", so buyers at a busy stall don't collide. Both are tested against the VM, including attacks, and on chipnet: member stamp [`14875f6d…`](https://chipnet.imaginary.cash/tx/14875f6d30c42372342efc84372e133c9061986be0074cc5197723f7276dac28).

**Levy rallies close the last hole.** If every stall in a set secretly refunded the buyer, a plain rally could be drained. In a levy rally (`StampMinter3` + `RewardVault2`), every stamp pays a levy into the pool, and the deploy script requires the levies of one set to cover its reward. Colluding stalls end up paying the reward themselves. Levy coins are merged into the vault by anyone, without a signature, and the covenant only lets them grow the pool. Levy rallies can also have a **bonus tier** (visit every stall, get a bigger reward), and it obeys the same rules. There are 11 attack tests, and the full flow runs on chipnet with a bonus claim: unsigned merge [`e33259a3…`](https://chipnet.imaginary.cash/tx/e33259a3f5847efc838eccc202deaaf672ce714847862562a7f5561846c083ed). The stall dashboard (`#/stats`) recomputes every stall's sales from the chain, and wallets show the stamp art through BCMR.

### FoldingCash Reward Claims bounty (`claims/`)
Pull-based Merkle claims built on a **second "claimed" Merkle tree** that shares the earned tree's indices. A receipt NFT alone can't stop a double claim, because the claimer can just hide it. The keeper category has no minting authority, new roots wait behind a cancellable CSV timelock, and epochs only move forward. Shipped:
- a chipnet demo with 300 leaves, using **real FoldingCash Oct/Nov 2026 distro data**;
- depth-16 claims accepted by chipnet nodes;
- a watcher `sync` that rebuilds the claimed root from the chain;
- a push vs pull cost table (operator: 45,792 sats/month for 62 folders vs ~1,000 sats/epoch at any scale).

See `claims/README.md`.

### Build with XO / Migrate to XO (`xo/`)
Jelajah's buy-and-stamp step as an XO template. Its locking script assembles byte-for-byte to the live StampMinter covenant, so the XO engine spends the same minters as the web app. Executed on chipnet ([`ef106294…`](https://chipnet.imaginary.cash/tx/ef106294af3bd134fad1b7dc02a00ad5402abd306648a39bde67d798ad2c1f00)) and inspected in blaze.xo.cash. The invitation and template JSON are in the repo.
**Feedback (~500 words)**

> ⚠️ DRAFT prepared by Claude from the facts in `xo/README.md`. The bounty asks for personal feedback: Pugar, rewrite this in your own words, and keep, cut or add to it based on what you actually felt while building. Delete this note before submitting.

I came to XO with a covenant that was already live: Jelajah's StampMinter, written in CashScript and spent from a React app over WizardConnect. My goal was a template whose locking script assembles byte for byte to that covenant. That way the XO engine and the web app spend the same minters and mint identical stamps. It worked, and the template now executes on chipnet against the live rally. Here is what that path was like.

What I liked: the template is honest. Roles, inputs and outputs are declared up front, so reading `jelajah-stamp.template.json` tells you exactly what a buyer signs, which a hand-built transaction never does. The invitation flow also fits a real stall well. A cashier could start the invitation and the buyer's wallet could finish it, with no custom backend. The blaze.xo.cash inspector was the moment it clicked for me: I could see my own covenant's redeem script, the inputs and the SUCCESS result in one place.

Where I lost time:

1. **NFT commitments built from an expression are decoded as UTF-8.** My stamp commitment is `merchantId ‖ buyer pkh`, 21 raw bytes. Computing it in the template (`OP_3 OP_SPLIT …`) gave a garbled 11-byte value, because the result is read as text and then parsed as hex. I worked around it by passing the commitment hex as a string variable. The covenant still enforces the real rule, but a template author would expect raw bytes there, and nothing warns you.
2. **Contract inputs and signing.** `listOwnInputIndexes` skips the contract input, yet `listMissingRequirements` still reports it as unsigned. Signing it through `signInvitation(0)` fails with `InputUnspentOutputUnavailableError`. What worked was putting `unlockingBytecode` on the input in `createInvitation`. A short "spending a P2SH32 covenant input" example in the docs would have saved me hours.
3. **Reservations survive restarts.** After a dry run, the next run failed with a reservation conflict until I found `archiveInvitation`. A clear error message that names it, or a TTL on reservations, would help.
4. **Variable types.** `bytes` and `locking_script` take hex strings, but `token_category` must be a 64-character hex string, not a `Uint8Array`. That's fine once known, but it's inconsistent with what libauth users pass around.
5. After a successful broadcast, shutting down the engine threw an Electrum subscribe error on chipnet Fulcrum. The transaction itself was fine, but it looks like a failure.

My most useful trick was assembling the template's CashASM with libauth and diffing it against CashScript's redeem bytecode. A built-in "compare with this artifact" check in XO would make porting existing CashScript contracts much easier, and that's probably the main way projects will migrate.

What I'd build next: the claim action. It burns 3 stamps at a covenant that loops over its inputs, so it needs a template input per stamp. I'd like to see how XO expresses "N inputs of this kind" for loop-checked covenants. That's where templates could really beat hand-written transaction code.

**Proof of presence (optional per stall).** A stall can require its phone to sign `rally ‖ stall ‖ buyer ‖ minter coin`, and the covenant checks it with `checkDataSig`. The buyer shows a QR, the stall's `#/device` page signs it, and the buyer scans the reply. A shared screenshot is useless to anyone else, because the signature names the buyer, and each code works once, because it names the minter coin the stamp spends. Tested against the VM (5 attacks, including replay) and on chipnet: presence stamp [`7f38aa76…`](https://chipnet.imaginary.cash/tx/7f38aa76b7e4a960fb5d65f287a0118c4aa9fae51fbd9c49c151966d7600404a). Organizers can also open their own rally from the browser (`#/organize`) and share it as a link.
