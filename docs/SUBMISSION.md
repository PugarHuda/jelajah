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

**Tech:** CashScript 0.14 (StampMinter 94 B, RewardVault 170 B), CashTokens, WizardConnect, React/Vite. The test suite runs every transaction against the BCH VM, including the attack cases. Tested end to end with Selene on chipnet. Run end to end on mainnet with the first rally: 3 stamps, then claim + trophy [`0e071a46…`](https://blockchair.com/bitcoin-cash/transaction/0e071a4648f8ac6ab48bf97f48e72ff473dfd5af3fa3bc6a131e5974ab528b33). The live demo is rally v2 on mainnet (genesis [`4c96cba2…`](https://blockchair.com/bitcoin-cash/transaction/4c96cba232afc690f841ffa7b4e10680de7b3123df4836da50700fa208a2601d)).

**New in v2: your trophy is a membership card.** `StampMinter2` charges a member price when you show your own trophy, and the covenant forces the trophy straight back to you in the same transaction. Each stall also gets 2 minter "lanes", so buyers at a busy stall don't collide. Both are tested against the VM, including attacks, and on chipnet: member stamp [`14875f6d…`](https://chipnet.imaginary.cash/tx/14875f6d30c42372342efc84372e133c9061986be0074cc5197723f7276dac28). The stall dashboard (`#/stats`) recomputes every stall's sales from the chain, and wallets show the stamp art through BCMR.

### FoldingCash Reward Claims bounty (`claims/`)
Pull-based Merkle claims built on a **second "claimed" Merkle tree** that shares the earned tree's indices. A receipt NFT alone can't stop a double claim, because the claimer can just hide it. The keeper category has no minting authority, new roots wait behind a cancellable CSV timelock, and epochs only move forward. Shipped:
- a chipnet demo with 300 leaves, using **real FoldingCash Oct/Nov 2026 distro data**;
- depth-16 claims accepted by chipnet nodes;
- a watcher `sync` that rebuilds the claimed root from the chain;
- a push vs pull cost table (operator: 45,792 sats/month for 62 folders vs ~1,000 sats/epoch at any scale).

See `claims/README.md`.

### Build with XO / Migrate to XO (`xo/`)
Jelajah's buy-and-stamp step as an XO template. Its locking script assembles byte-for-byte to the live StampMinter covenant, so the XO engine spends the same minters as the web app. Executed on chipnet ([`ef106294…`](https://chipnet.imaginary.cash/tx/ef106294af3bd134fad1b7dc02a00ad5402abd306648a39bde67d798ad2c1f00)) and inspected in blaze.xo.cash. The invitation and template JSON are in the repo.
**Feedback (~500 words, must be written by Pugar personally):** TODO. Raw facts are in `xo/README.md`.
