# DoraHacks BUIDL: BCH BLAZE 2026 submission text

**Name:** Jelajah

**One-liner (Vision field):** A stamp rally on Bitcoin Cash: pay a stall, get its stamp NFT in the same transaction, burn a set of 3 to get paid back.

**Not a loyalty card, a rally.** A loyalty card is one shop paying back its own customers. Jelajah puts **many independent stalls behind one shared prize pool** that pays only for stamps from *different* stalls, and the pool can't be drained even if stalls collude: in a levy rally, colluding stalls end up paying the prize themselves.

**Links**
- Live demo: https://jelajah-bch.vercel.app
- Code: https://github.com/PugarHuda/jelajah
- Deck (Widget Factory template): https://jelajah-bch.vercel.app/deck.pdf
- CashTokens address (EMBER2026 votes / prizes): bitcoincash:zrd56cv5ap5v2kc2dgc8hvt4e9g84pmrjcydclcrgj

**Tracks:** Mainnet Track
**Bounties:** FoldingCash Reward Claims (`claims/`) · Build with XO + Migrate to XO (`xo/`) · SolidCash (`solidcash/`) · Decentralised Identity (`docs/IDENTITY.md`). One BUIDL can apply to several bounties: press **Apply** on each bounty card and choose this BUIDL.

**Prior work:** none. Built from scratch during BLAZE; first commit 17 Nov 2026.

---

## Description

Food festivals and malls in Jogja run stamp cards: eat at five stalls and win a prize. The cards are paper, easy to fake, and the prize depends on the organiser keeping their word. **Jelajah** moves this on chain.

**How it works**
1. **Pay a stall** with any WizardConnect wallet (Selene, Paytaca, Cashonize). The stall's covenant only lets its stamp NFT out if the stall was paid at least its price, in the same transaction.
2. **Collect stamps** from 3 different stalls. Each stamp carries the buyer's key hash, so stamps can be traded as collectibles, but only the real buyer can claim with them.
3. **Burn the set.** The reward vault loops over the stamps (using the 2026 VM loops), checks they come from 3 different stalls and were all bought by you, then pays you back and mints a **Trophy** NFT.

There is no sign-up, no server and no database. The prize is locked in a covenant, so the organiser can't take it back before the rally ends.

**▶ Try it on mainnet in 2 minutes (about 12,000 sats in, 3,000 back: a few US cents).** Open https://jelajah-bch.vercel.app, press **Connect wallet** and scan with Selene or Paytaca (WizardConnect). Then:
1. Buy at 3 stalls: 4,000 sats each (1,500 to the stall + a 2,500 levy into the prize pool), plus about 500 in fees.
2. Press **Claim**: 3,000 sats come back, along with a Trophy NFT. Your set's own levies paid that reward, which is why colluding stalls can't drain the pool.
3. Optional: buy at the 4th stall too and the claim becomes the **bonus tier** (4,500 sats). Or buy again after claiming and the button shows **★ member price**: your trophy is your membership card.

Every step is one wallet prompt, and each one is a real covenant transaction on BCH mainnet.

**How it scores on the four questions**
- **Cool?** The stamp is printed by the payment itself. The prize sits in a covenant nobody can touch. The trophy is a membership card.
- **Slick?** One button per step, works on a phone, Bahasa Indonesia / English, rupiah prices, stall posters with QR codes. No sign-up.
- **Does it work?** The full lifecycle is on mainnet: stamps, claim and trophy (links below). There are 68 VM checks, about 40 of them attack cases, plus 8 Playwright UI tests. Every feature was also run with a real wallet (Selene) over WizardConnect.
- **Does it make money?** Organisers (malls, festivals, tourism boards) pay per rally, and in a levy rally the organiser earns on every set: the levies exceed the reward (by ≥ 2,100 sats per set on the live mainnet rally), and that surplus comes back to them with `reclaim` after the end, enforced by the contracts. Sponsors fund subsidised stamps. Every stamp is a paid visit the stall can prove on the `#/stats` dashboard, and the stall's till (`#/till/<id>`) rings the moment one is paid.

**What makes it a rally and not a loyalty card.** A loyalty card is one shop paying back its own customers. Jelajah is **many independent stalls behind one prize pool**, and the hard part is keeping that pool honest:
- the vault loops over stamps from *different* stalls;
- the anti-farming rule stops a stall from buying its own way to the prize;
- levy rallies stop stalls from colluding;
- single-use proof of presence shows the buyer was physically there.

**Why it's a business:** organisers, malls and brands pay per rally, and every stamp is a paid visit they can prove. The anti-farming rule (reward < cheapest full set) means a stall can never profit from buying its own stamps.

**Tech:** CashScript 0.14 (StampMinter 94 B, RewardVault 170 B), CashTokens, WizardConnect, React/Vite. The test suite runs every transaction against the BCH VM, including the attack cases. Tested end to end with Selene on chipnet. Run end to end on mainnet with the first rally: 3 stamps, then claim + trophy [`0e071a46…`](https://blockchair.com/bitcoin-cash/transaction/0e071a4648f8ac6ab48bf97f48e72ff473dfd5af3fa3bc6a131e5974ab528b33). The live demo is now the **levy rally on mainnet** (anti-collusion + bonus tier, genesis [`e0ed3240…`](https://blockchair.com/bitcoin-cash/transaction/e0ed3240f589bafe01996f2a8f54a4f32077ecb212df24a7cfcdb2ab6c19752e)); before it, rally v2 ran there (genesis [`4c96cba2…`](https://blockchair.com/bitcoin-cash/transaction/4c96cba232afc690f841ffa7b4e10680de7b3123df4836da50700fa208a2601d), stamp [`8b3d8dec…`](https://blockchair.com/bitcoin-cash/transaction/8b3d8deccc37c42ec9e8850dc6483591ee524e5d4c672d89e04eb579ee5bd596)). The organizer page and proof of presence were also tested with Selene over WizardConnect on chipnet.

**New in v2: your trophy is a membership card.** `StampMinter2` charges a member price when you show your own trophy, and the covenant forces the trophy straight back to you in the same transaction. Each stall also gets 2 minter "lanes", so buyers at a busy stall don't collide. Both are tested against the VM, including attacks, and on chipnet: member stamp [`14875f6d…`](https://chipnet.imaginary.cash/tx/14875f6d30c42372342efc84372e133c9061986be0074cc5197723f7276dac28).

**Levy rallies close the last hole.** If every stall in a set secretly refunded the buyer, a plain rally could be drained. In a levy rally (`StampMinter3` + `RewardVault2`), every stamp pays a levy into the pool, and the deploy script requires the levies of one set to cover its reward. Colluding stalls end up paying the reward themselves. Levy coins are merged into the vault by anyone, without a signature, and the covenant only lets them grow the pool. Levy rallies can also have a **bonus tier** (visit every stall, get a bigger reward), and it obeys the same rules. There are 11 attack tests, and the full flow runs on chipnet with a bonus claim: unsigned merge [`e33259a3…`](https://chipnet.imaginary.cash/tx/e33259a3f5847efc838eccc202deaaf672ce714847862562a7f5561846c083ed). The stall dashboard (`#/stats`) recomputes every stall's sales from the chain, and wallets show the stamp art through BCMR.

### FoldingCash Reward Claims bounty (`claims/`)
Pull-based Merkle claims built on a **second "claimed" Merkle tree** that shares the earned tree's indices. A receipt NFT alone can't stop a double claim, because the claimer can just hide it. The keeper category has no minting authority, new roots wait behind a cancellable CSV timelock, and epochs only move forward. Shipped:
- a chipnet demo with 300 leaves, using **real FoldingCash Oct/Nov 2026 distro data**;
- depth-16 claims accepted by chipnet nodes, and the **full lifecycle on mainnet**: claim [`cb2e5a51…`](https://blockchair.com/bitcoin-cash/transaction/cb2e5a51488c88e4f78d1afc9229efd10ba6d044da8c2ea1347439fcb1bf6df8) → epoch 1 activated after the CSV delay [`c7b58ccf…`](https://blockchair.com/bitcoin-cash/transaction/c7b58ccf310ed3659760d657590f5e5e56191dde18b41c8b1e43420fedd47b8f) → claim on the new root [`aebb5f33…`](https://blockchair.com/bitcoin-cash/transaction/aebb5f332e1acf52f04f01cd9fad7005966465476e0c634ca022d1761ee5891a) → `sync` rebuilds a root that matches the keeper;
- a watcher `sync` that rebuilds the claimed root from the chain;
- a push vs pull cost table (operator: 45,792 sats/month for 62 folders vs ~1,000 sats/epoch at any scale).

See `claims/README.md`.

### SolidCash bounty (`solidcash/`)
The stall's loyalty card, ported to SolidCash as `StampCard.scash`:
- what it uses: a covenant-verified `mapping(bytes20 => Card)`, a struct, an enum, a `library` with a loop, modifiers, events and custom errors;
- customers redeem with their own `checkSig`, and the stall uses its signature to pause or withdraw;
- a constructor rule means a full card always costs more than its reward;
- size: 6,657 bytes (the framed build was 16.6 kB, over the 10 kB limit);
- tests: 7 solidhat tests;
- the full lifecycle ran on **BCH mainnet**: contract `bitcoincash:rdrsk0x7…` [deploy `14d3ce94…`](https://blockchair.com/bitcoin-cash/transaction/14d3ce94683315902f4d278c14b49781e6799b8b44d61e1cd39692d773af15d8) → [fund](https://blockchair.com/bitcoin-cash/transaction/960df8632a4a848b7aa3dd8c58c3c37d2a20a4c9a78667ce6ba576e79b7a6c98) → visits [1](https://blockchair.com/bitcoin-cash/transaction/739db1a706f0e4df4f86a58d5682dfa97dee2a9c3754c89e94dc6487300e6834) [2](https://blockchair.com/bitcoin-cash/transaction/fa774ccdc7172a7ff1f552bedede74ce77644fb7276d70ca091c7d3c59d2e0ef) [3](https://blockchair.com/bitcoin-cash/transaction/56108aeb98185d3763436cc1fa092b23471f98813de6e3f748730a9b3185d19a) → [redeem `8d122760…`](https://blockchair.com/bitcoin-cash/transaction/8d122760c076254b72ee42f9dbdfcee26fe0ad940a6181b53a5fa11399202994). The card read back on chain: lifetime 3, redeemed 1, tier Regular. Funded by a community donation (Base USDC bridged through NEAR Intents, the route hashi.cash uses);
- before that, the same lifecycle ran on chipnet ([deploy `d898cd1a…`](https://chipnet.imaginary.cash/tx/d898cd1aa5fb079c996ab3fa82a5bdd2a3b6eb1d6a1e75923f788321014937f6) → fund → 3 visits → [redeem `196b364e…`](https://chipnet.imaginary.cash/tx/196b364edf351aaa684e2f4aecbb15d03393e7fdd78ffeab91387c1a0a81931c)), shown at `#/solidcash`.

Upstream fix: [solidcash/solidcash#14](https://github.com/solidcash/solidcash/pull/14). The compiler printed each warning up to 3 times (8 lines for 3 sites); it now prints each once.

### Decentralised Identity bounty (`docs/IDENTITY.md`)
Jelajah ID links a BCH address and a Nostr key, with no identity server:
- the address spends a coin in a proof tx whose OP_RETURN commits to the statement and the Nostr key;
- the Nostr key signs a kind-30078 event naming the address and that proof;
- anyone can find the link by npub or by address and verify both sides from public relays and the chain (`scripts/verify-identity.mjs`, `#/identity`);
- the link is also a standard **NIP-39** claim (kind 10011), and an independent verifier (TwinKey's) shows it as ✓ Verified;
- extras: challenge login bound to the site origin, the rally reputation of the verified address, and pay-by-identity.

Live on mainnet: proof [`da731db2…`](https://blockchair.com/bitcoin-cash/transaction/da731db2956c3ab85474339e96c338155073869cb7fcb40d1a26ce3cc0dd437f). Offline tests refuse 5 forgery shapes, shadowing by junk events, and wrong-site logins.

### Build with XO / Migrate to XO (`xo/`)
Jelajah's whole customer journey as an XO template: `buyStamp` and `claimSet`. Its locking scripts assemble byte-for-byte to the live StampMinter and RewardVault covenants, so the XO engine spends the same minters and vault as the web app. Executed on chipnet: a stamp ([`ef106294…`](https://chipnet.imaginary.cash/tx/ef106294af3bd134fad1b7dc02a00ad5402abd306648a39bde67d798ad2c1f00), inspected in blaze.xo.cash), then a full set of 3 stamps and **the claim [`71ca9dee…`](https://chipnet.imaginary.cash/tx/71ca9deebc3f056becba02cd2702d6579ba2a5465c9df7425bb38329596fc7be)** (reward + trophy, dry run checked by the BCH 2026 VM first). The same journey also ran **on mainnet** against mainnet rally v1: claim [`70efa57c…`](https://blockchair.com/bitcoin-cash/transaction/70efa57cbf453afedf32efd76bbc8ef513fb4d7105d473c79afd537de8b3ac0e). The invitations and template JSON are in the repo.
**Feedback (~500 words)**

> ⚠️ DRAFT v2 for Pugar to review. Change anything that doesn't sound like you, fill the [ISI: …] spots with what really happened, and delete this note before it goes on DoraHacks.

I'm a solo builder from Jogja, and Jelajah already had live covenants before I touched XO: a stall minter and a reward vault, written in CashScript and driven from a React app over WizardConnect. So I didn't start from a blank template. I wanted the XO version to spend the exact same contracts, byte for byte, so a stamp bought through XO and a stamp bought in the web app are the same thing. That part worked. Both actions, buying a stamp and claiming a set, now run through the XO engine on chipnet and on mainnet.

The good part first. Reading the template tells you who signs what before anything is built, and I can't say that about my own transaction code. The invitation idea fits a stall well: the cashier starts it, the buyer's wallet finishes it, no backend. And the blaze.xo.cash inspector was the first time I saw my own redeem script, inputs and SUCCESS on one screen. [ISI: how that moment felt, or what you showed someone]

Where I got stuck:

- The stamp commitment is 21 raw bytes (stall id + buyer pkh). Computing it inside the template gave me a broken 11-byte value, because the result gets read as text and then parsed as hex. I ended up passing the hex in as a string variable. Nothing told me this was happening.
- Spending a covenant input took me the longest. [ISI: roughly how long] `listOwnInputIndexes` skips it, `listMissingRequirements` still calls it unsigned, and signing it fails. Putting `unlockingBytecode` on the input in `createInvitation` is what finally worked. One example of spending a P2SH32 covenant in the docs would save people a lot of time.
- My claim burns 3 stamps, and the vault loops over them on chain. A template input is one fixed slot, so I couldn't say "3 stamp inputs here". The stamps go in as plain wallet inputs and only the covenant knows the rule. If XO could declare "N inputs of this kind", templates would describe loop-based covenants properly.
- The one that cost real money: the engine's unspent output records don't carry token data. When I let my script use every spendable coin, the engine also picked up two stamps I had just bought on mainnet as if they were plain BCH, and they were burned. Now I check token outpoints through Electrum myself. A token-aware spendable list would protect every XO wallet from this.
- Smaller things: dry runs keep inputs reserved until you find `archiveInvitation`; on start the engine syncs headers and shows no coins for a while; after a successful broadcast it sometimes throws a subscribe or reservation error, so a success looks like a failure.

The trick that saved me was assembling the template's CashASM with libauth and diffing it against CashScript's bytecode before every run. If XO had a "compare with this CashScript artifact" check built in, migrating existing contracts would be much easier, and I think most projects will come to XO exactly that way.

[ISI: one or two sentences on whether you'd use XO again for the next Jelajah feature, and why]

**Proof of presence (optional per stall).** A stall can require its phone to sign `rally ‖ stall ‖ buyer ‖ minter coin`, and the covenant checks it with `checkDataSig`. The buyer shows a QR, the stall's `#/device` page signs it, and the buyer scans the reply. A shared screenshot is useless to anyone else, because the signature names the buyer, and each code works once, because it names the minter coin the stamp spends. Tested against the VM (5 attacks, including replay) and on chipnet: presence stamp [`7f38aa76…`](https://chipnet.imaginary.cash/tx/7f38aa76b7e4a960fb5d65f287a0118c4aa9fae51fbd9c49c151966d7600404a). Organizers can also open their own rally from the browser (`#/organize`) and share it as a link.
