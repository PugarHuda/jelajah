# Jelajah

![The four Jelajah Jogja stamps and the trophy](public/stamps.png)

**Live demo:** https://jelajah-bch.vercel.app (mirror: https://pugarhuda.github.io/jelajah/) · **Deck (Widget Factory template):** https://jelajah-bch.vercel.app/deck.pdf

**A stamp rally on Bitcoin Cash.** Pay a stall and its stamp NFT is printed in the same transaction. Collect stamps from 3 different stalls, burn them, and the rally's contract pays you back and mints your trophy.

*Jelajah* is Indonesian for "to roam, to explore". The demo rally, **Jelajah Jogja**, has four Yogyakarta street-food stalls.

Built from scratch for **BCH BLAZE 2026** (Mainnet track). The first commit is from 17 Nov 2026, and there is no pre-existing code.

## Why

- **Stalls:** small food stalls have no cheap way to bring in new customers, and a loyalty card only works at one shop.
- **Stamp rallies:** collecting stamps across many places for a prize already works on paper (eki stamps in Japan, mall and food-festival promos in Indonesia). But paper stamps are easy to fake, and the prize depends on the organizer keeping their word.
- **Jelajah** makes every stamp proof of a real, paid visit, and locks the prize money in a contract.

## How it works

| Step | Who | On chain |
|---|---|---|
| 1. Open a rally | Organizer | Genesis of one token category: one **minting NFT per stall** (each held by that stall's `StampMinter` covenant) and one for the `RewardVault`, which also holds the reward pool. |
| 2. Buy | Customer | One transaction spends the stall's minter and pays the stall at least its price. The minter only lets a stamp out to the buyer if that payment is there. Stamp commitment = `stall id ‖ buyer pkh`. |
| 3. Claim | Customer | One transaction burns stamps from `needed` different stalls. The vault loops over them and checks: same category, stall ids strictly increasing (so all different), all bought by the same pkh. It pays the reward to that pkh and mints a **Trophy** NFT (stall id `00`). |
| 4. Close | Organizer | After `endTime`, `reclaim` returns whatever is left. Before that, the pool cannot be touched. |

There is no server and no database. State lives in UTXOs and NFT commitments, and the app reads the chain over Electrum from the browser.

### Contracts (`contracts/`, CashScript 0.14)
- `StampMinter.cash`, 94 bytes: `stamp()`.
- `RewardVault.cash`, 170 bytes: `claim()` (uses the 2026 VM's loops) and `reclaim()`.
- `StampMinter2.cash`, 152 bytes, used by new rallies: `StampMinter` plus a **member price**. Your trophy becomes a membership card. Show it as input 1 and every stall charges you its `memberPrice`, as long as the trophy (commitment `00 ‖ your pkh`) goes straight back to you at output 3. Only the vault can mint `00`, a traded trophy doesn't match your pkh, and keeping the discount while sending the trophy elsewhere is rejected.
- `StampMinter3.cash` (167 bytes) + `RewardVault2.cash` (288 bytes), **levy rallies**, optionally with a **bonus tier**: burn `bonusNeeded` different stalls (more than `needed`) for `bonusReward`. A claim takes the bonus path exactly when input `bonusNeeded` is also a rally stamp, so you can't take the small reward while burning a bonus set, or the bonus for a small set. The deploy rules (anti-farming, anti-collusion) are checked again at the bonus size. Every stamp must also pay `levy` sats to the vault address in the same transaction (output 3). The levy coins pile up next to the vault, so buyers never race for the vault coin. `merge()` lets **anyone, without a signature** fold them into the vault coin. Every input checks that the only output is the vault itself, still carrying its minting NFT and holding everything minus at most 600 sats per input, and never less than the vault coin itself, so levies can only ever grow the pool. The deploy script requires `needed × (levy − 600) − 600 ≥ reward`, so each set's reward is paid by the levies of the stamps it burns. Config: `scripts/rally.levy.config.json`.
- **Proof of presence** (optional per stall, `StampMinter3`, 200 bytes). A stall with a `presenceKey` only mints when its device signed `rallyCategory ‖ stall id ‖ buyer pkh ‖ the minter outpoint this stamp spends` (`checkDataSig`). The buyer's app shows their buyer code as a QR. The stall's phone (`#/device/<id>`, which keeps its key in the browser) scans it and shows the signature as a QR, and the buyer scans that back before paying. Scanning uses the browser's own `BarcodeDetector`, and the code can always be pasted instead. The signature names the buyer, so a screenshot shared online is useless to anyone else. It also names the exact minter coin, which every stamp spends and recreates, so **each code works once**. The app picks the lane before showing the buyer's code (`pkh:txid:vout`). If another buyer happens to use that lane first, the stall just signs again.
- **Lanes:** each stall gets several minter coins at the same covenant address (`lanes` in the config), and the app picks one at random, so two people buying at the same stall in the same second don't fight over one coin. The contract needed no change, because each lane hands its minting NFT back to itself.

### Threat model
| Attack | Why it fails |
|---|---|
| A stall buys from itself to farm rewards | A set needs N different stalls, and the deploy script enforces **reward < the cheapest full set**, so farming loses money. |
| Buying second-hand stamps to claim | Stamps can be traded as collectibles, but the reward and trophy always go to the pkh that bought them. |
| The organizer runs off with the pool | The vault only pays out through `claim()` until `endTime`. |
| Extra stamps minted / a minter drained | Minter value and token must come back unchanged, and no other output may carry tokens. |
| A trophy reused as a stamp | Trophy id `00` can never satisfy `id > prev` starting from 0. |
| Bonus for a small set, the small reward while burning a bonus set, or a bonus set with a repeated stall | `RewardVault2` decides the tier from the inputs themselves (input `bonusNeeded` is a rally stamp or not) and loops over that many strictly increasing stall ids (3 VM attack tests). |
| Buying a presence stall's stamp without being there (a shared screenshot of the stall's code, another device's key, another stall's code, replaying a used code) | The signature must be the stall device's, over this rally, this stall, *this* buyer's pkh and the minter coin being spent, which no longer exists after use (5 VM attack tests). |
| Member discount without a trophy, with someone else's trophy, or while keeping the trophy away from its owner | `StampMinter2` only lowers the price when input 1 is a rally trophy whose commitment is `00 ‖ buyer pkh`, and it requires that exact trophy back at the buyer's address. The anti-farming check uses the member price. |
| **Every stall in a set colludes** with a buyer and refunds them off-chain | **Closed by levy rallies (`StampMinter3` + `RewardVault2`).** Each stamp pays a levy into the pool and the levies of one set cover its reward, so the colluding stalls fund the payout themselves and nothing is gained. VM test: `carol's set was paid from its own levies`. Levy coins can't be redirected, burned as fee, skimmed, pocketed inside a claim, or used to pay a merge's fee out of the pool (6 attack tests). **In the original StampMinter / StampMinter2 rallies, this is not prevented on chain.** The buyer pays only fees, so the pool can be drained one reward at a time. The price rule only stops a single cheater. A merchant co-signature doesn't help (the merchants are the colluders), and one claim per pkh is beaten by using many addresses. The real fix is governance: **the stalls fund the pool themselves** in proportion, so colluding only drains their own money. (In the demo every stall payment goes to the organizer, who also funds the pool, so the risk is zero.) An optional organizer co-signature on each stamp is the centralized alternative. |

## Try it
Open the demo, press **Connect wallet**, and scan the code with Selene or Paytaca (WizardConnect). Buy at 3 stalls, then claim.

## Run it
```bash
npm install
npm run check     # compiles the contracts and runs the full rally, including attacks, against the BCH VM (mock network)
npm run dev       # web app
node scripts/rally.mjs address --network chipnet                 # organizer funding address
node scripts/rally.mjs deploy  --network chipnet [--registry https://<host>/bcmr.json]
node scripts/smoke.mjs --network chipnet                         # real-network end to end: 3 stamps + claim
node scripts/rally.mjs deploy  --network chipnet --config scripts/rally.levy.config.json   # levy rally (anti-collusion)
node scripts/rally.mjs bcmr    --network chipnet --registry https://<host>/bcmr.json   # new BCMR revision (icons) via the authchain, no redeploy
```
**Open your own rally:** `#/organize`. Fill in stalls, prices, the prize and an optional levy. The same rule checks and genesis builder as the CLI (`checkRallyConfig`, `planRally`, `buildGenesis` in `src/lib/tx.js`) run in the browser, and the organizer's wallet signs over WizardConnect. If no vout-0 coin exists, it first signs one send-to-self. The finished rally travels in its share link (`?rally=<base64url JSON>`), so there is still no server. The link is treated as untrusted input: it is shape-checked, and stall colours and text are sanitised.

**Stall dashboard:** open `#/stats` in the app. Stamps sold, unique buyers, sats paid to each stall and sets claimed, all recomputed in the browser from each covenant's history, plus a **top-collectors** board (stalls visited, stamps, trophies per address). Prices also show a rupiah estimate (a CoinGecko rate, nothing about the user is sent). A transaction only counts if it really spent the covenant (the rally's minting NFT goes back to it at out[0]), so nobody can inflate the numbers by sending junk to a minter address.
`scripts/rally.config.json` sets the stalls, prices, reward and duration. `--merchant-address` pays real stall wallets.

## Mainnet rally v2 (19 Nov 2026, live demo)
The live demo runs **Jelajah Jogja on BCH mainnet** with `StampMinter2` (member price 1,800 sats for trophy holders) and **2 lanes per stall**. Add `?net=chipnet` for the test rally. Pool: 4 rewards × 5,000 sats + 1,000 sats dust. Open for 60 days.
- Genesis: [`4c96cba2…`](https://blockchair.com/bitcoin-cash/transaction/4c96cba232afc690f841ffa7b4e10680de7b3123df4836da50700fa208a2601d) (8 minter coins + vault) · category `082ad61858ea6ad7c75c7f2b1d2cbf8293a61e91fa46464b2e66c0dadcec24ad`
- Reward vault: `bitcoincash:rv603w2k07qrq9dcasfl3u2es204lfzjk42njsnayqgk0gxz2p4xcmuvyrzjf`
- BCMR metadata with stamp and trophy icons, hash-committed in the genesis: [`bcmr.json`](https://pugarhuda.github.io/jelajah/bcmr.json)
- First v2 stamp on mainnet, bought through the `StampMinter2` covenant from a throwaway buyer that was swept back afterwards: [`8b3d8dec…`](https://blockchair.com/bitcoin-cash/transaction/8b3d8deccc37c42ec9e8850dc6483591ee524e5d4c672d89e04eb579ee5bd596). The `#/stats` dashboard picks it up.

## Mainnet rally v1 (19 Nov 2026, retired)
The first mainnet rally, on the original `StampMinter`. It is no longer the demo, but its history is the mainnet end-to-end proof. Its remaining pool comes back after it ends (18 Jan 2027) with `node scripts/rally.mjs reclaim --network mainnet --rally scripts/rally.mainnet-v1.json`. The pool was 30,000 sats but only 5 rewards were claimable, because the vault must keep 1,000 sats of dust under its minting NFT. The deploy script now adds that dust on top of the pool.
- Genesis: [`47f7df27…`](https://blockchair.com/bitcoin-cash/transaction/47f7df27c3142503911eee2fcd76199be91d64fbae0b4fa621041268a65b7f34) · category `026421ea8dc5944c03a0b2151f3c44a89ae307adc0cb828cc25ead05a4c5494f`
- Reward vault: `bitcoincash:r057jerhmlqvykrwg9h8s6y4z8cuzc6856hf7k2n3kagwaz7p5w86nxj262cl`
- BCMR revision 1.1 (icons) published along its authchain in [`85ccbf71…`](https://blockchair.com/bitcoin-cash/transaction/85ccbf7111bd700c9f8ebf899934dd7b26091dc90f05149316137ab019057395)
- **End to end on mainnet** (`smoke.mjs`, 19 Nov 2026): stamps [`60513b45…`](https://blockchair.com/bitcoin-cash/transaction/60513b45ff9fd8be183710554b3707ee3d6f2a71cb963ec025a8a921918c7bba) · [`196503e3…`](https://blockchair.com/bitcoin-cash/transaction/196503e31c0b09f6fdb605c361280b4a2ca4fc263dedca5c9beec7c7371f72e0) · [`a7fb6db1…`](https://blockchair.com/bitcoin-cash/transaction/a7fb6db15732b5c015c59fac9dd5ac8116919b8b17d49591120700c682174521) · claim + trophy [`0e071a46…`](https://blockchair.com/bitcoin-cash/transaction/0e071a4648f8ac6ab48bf97f48e72ff473dfd5af3fa3bc6a131e5974ab528b33)

## Chipnet run, levy rally with a bonus tier (20 Nov 2026, current `?net=chipnet`)
Price 4,000 sats (member 3,600) + a 2,200 sats levy per stamp. Reward 4,000 for 3 stalls, **bonus 5,500 for all 4**. The genesis is built by the shared `planRally`/`buildGenesis` code that the organizer page also uses.
- Genesis: [`a7ba3a49…`](https://chipnet.imaginary.cash/tx/a7ba3a4976fda7a91c3d94fd58915e67174cae908d580ca489364b31949859c4)
- 4 stamps with levy [`a8e6b6ac…`](https://chipnet.imaginary.cash/tx/a8e6b6accb6ba8770e2da00af1222052c3b2d809abef9858019ac0e06f27c042) · [`5e97fa6a…`](https://chipnet.imaginary.cash/tx/5e97fa6a96db9660744ec2c16d4406d0709bb198e36c46460c1f963a6f45bf93) · [`d39efd62…`](https://chipnet.imaginary.cash/tx/d39efd627e67eea6ce5f18d5caa8c6b7d17ad99eb1f7ac3290fdf540e80ba8ae) · [`3e87822a…`](https://chipnet.imaginary.cash/tx/3e87822a39e8491d612976b5b711a005bc813cd4c7d45108ad543b758f93321d)
- **Unsigned merge** of the levies: [`e33259a3…`](https://chipnet.imaginary.cash/tx/e33259a3f5847efc838eccc202deaaf672ce714847862562a7f5561846c083ed) · **bonus claim** (vault paid 5,500) + trophy [`dda26dd1…`](https://chipnet.imaginary.cash/tx/dda26dd123b0498cdd066b86a0a6f4f553c71080edf50b5e0d7354e53838a261) · member stamp [`e2753335…`](https://chipnet.imaginary.cash/tx/e275333599676b11f441ffab84e153ccad0354b7548405e6b8073d3f965aead8)

## Chipnet run, proof of presence (20 Nov 2026, link-only rally)
Levy rally where **Kopi Joss and Bakmi Jawa require their device's signature**, made single-use by binding it to the minter coin. Created with `rally.mjs deploy --config scripts/rally.presence.config.json --out scripts/rally.presence.chipnet.json`. Open it from its [share link](https://jelajah-bch.vercel.app/?rally=eyJuZXR3b3JrIjoiY2hpcG5ldCIsIm5hbWUiOiJKZWxhamFoIEpvZ2phIChwcmVzZW5jZSkiLCJkZXNjcmlwdGlvbiI6IkxldnkgcmFsbHkgd2hlcmUgdHdvIHN0YWxscyBhbHNvIHJlcXVpcmUgdGhlaXIgZGV2aWNlIHRvIHNpZ24gZm9yIGVhY2ggYnV5ZXIsIHByb3ZpbmcgdGhlIGJ1eWVyIHdhcyB0aGVyZS4iLCJjYXRlZ29yeSI6IjcwYTljODkyZjIzNTFmNGY3YzI3YWNlM2E4MDI4NTFjYjU2YjVjMjNmNGZiNGMyMWUzN2JmMDdmMWMyYzM3YjgiLCJ2bUNhdGVnb3J5IjoiYjgzNzJjMWM3ZmYwN2JlMzIxNGNmYmY0MjM1YzZiYjUxYzg1MDJhOGUzYWMyNzdjNGYxZjM1ZjI5MmM4YTk3MCIsIm5lZWRlZCI6MywicmV3YXJkIjo0MDAwLCJlbmRUaW1lIjoxODAwMzMyODkwLCJvcmdhbml6ZXJQdWIiOiIwMzNmNDFhMmVhZjlmYThhMmQ5YTIxYWRhNTgwMzEwOTRjZGNlMjk4MTYyNzEyMGYwOWFjODAzMzJhMzJiNjkzY2QiLCJsYW5lcyI6MiwibWludGVyIjozLCJsZXZ5IjoyMjAwLCJib251c05lZWRlZCI6NCwiYm9udXNSZXdhcmQiOjU1MDAsIm1lcmNoYW50cyI6W3siaWQiOjEsIm5hbWUiOiJLb3BpIEpvc3MiLCJ0YWdsaW5lIjoiQ2hhcmNvYWwgY29mZmVlIGJ5IHRoZSBzdGF0aW9uIiwiZW1vamkiOiLimJUiLCJjb2xvciI6IiM3YTRhMmIiLCJwcmljZSI6NDAwMCwidGFnbGluZUlkIjoiS29waSBhcmFuZyBkZWthdCBzdGFzaXVuIiwibWVtYmVyUHJpY2UiOjM2MDAsImxvY2siOiI3NmE5MTQ3ZDcyNzc0ZTY5OWUwNDkxOTViZjA3YzkwOWIwMjFiZTkxZjEwYTYyODhhYyIsInByZXNlbmNlS2V5IjoiMDIxMGE4OTc4MWEwYjdhZDIzZTg4NjNlNjFlODgyNzAzOTBjODFlZjIzZDU0NmU5ZDYzMmE5ODViOTYyZmI1OWUxIn0seyJpZCI6MiwibmFtZSI6IkJha21pIEphd2EiLCJ0YWdsaW5lIjoiV29vZC1maXJlIG5vb2RsZXMiLCJlbW9qaSI6IvCfjZwiLCJjb2xvciI6IiNjMjQxMGMiLCJwcmljZSI6NDAwMCwidGFnbGluZUlkIjoiTWkgZ29kaG9nIG1hc2FrIHR1bmdrdSIsIm1lbWJlclByaWNlIjozNjAwLCJsb2NrIjoiNzZhOTE0N2Q3Mjc3NGU2OTllMDQ5MTk1YmYwN2M5MDliMDIxYmU5MWYxMGE2Mjg4YWMiLCJwcmVzZW5jZUtleSI6IjAyNTE5Zjc3NGY3ZDMxZDBlYmZkNDFhNTY4ZTZlYTYwOWQ5ODg2MzA2MmQ5NjFlYTNlMGU1ZTVlM2I4YWM5OTU5ZiJ9LHsiaWQiOjMsIm5hbWUiOiJTYXRlIEtsYXRoYWsiLCJ0YWdsaW5lIjoiR29hdCBzYXRheSBvbiBiaWN5Y2xlIHNwb2tlcyIsImVtb2ppIjoi8J-NoiIsImNvbG9yIjoiI2I5MWMxYyIsInByaWNlIjo0MDAwLCJ0YWdsaW5lSWQiOiJTYXRlIGthbWJpbmcgdHVzdWsgamVydWppIHNlcGVkYSIsIm1lbWJlclByaWNlIjozNjAwLCJsb2NrIjoiNzZhOTE0N2Q3Mjc3NGU2OTllMDQ5MTk1YmYwN2M5MDliMDIxYmU5MWYxMGE2Mjg4YWMifSx7ImlkIjo0LCJuYW1lIjoiRXMgRGF3ZXQiLCJ0YWdsaW5lIjoiSWNlZCBjb2NvbnV0IGFuZCBwYWxtIHN1Z2FyIiwiZW1vamkiOiLwn6WlIiwiY29sb3IiOiIjMTU4MDNkIiwicHJpY2UiOjQwMDAsInRhZ2xpbmVJZCI6IkVzIGtlbGFwYSBkYW4gZ3VsYSBhcmVuIiwibWVtYmVyUHJpY2UiOjM2MDAsImxvY2siOiI3NmE5MTQ3ZDcyNzc0ZTY5OWUwNDkxOTViZjA3YzkwOWIwMjFiZTkxZjEwYTYyODhhYyJ9XSwiZ2VuZXNpc1R4IjoiNDgwOWMyMzY4MjIxMzBmOGRmODM0MTQ0NTNkMjQyZTZlMTk2MjhmZTc4NWRhNDYzODAwNzNhOTljNjk1OTVmYSJ9). The smoke run signed as each stall's device:
- Genesis: [`4809c236…`](https://chipnet.imaginary.cash/tx/4809c236822130f8df83414453d242e6e19628fe785da46380073a99c69595fa) · presence stamps [`7f38aa76…`](https://chipnet.imaginary.cash/tx/7f38aa76b7e4a960fb5d65f287a0118c4aa9fae51fbd9c49c151966d7600404a) (Kopi Joss) · [`873c2e6e…`](https://chipnet.imaginary.cash/tx/873c2e6e220ef5f027327a10aac932606ef242655cc51a9771d7b1bd82c28173) (Bakmi Jawa) · bonus claim [`4c3c03ad…`](https://chipnet.imaginary.cash/tx/4c3c03adf08bc5b4c07cafc8bf844d4f2546d397128f441c7a361f5629421673) · member stamp with presence [`4740fd4b…`](https://chipnet.imaginary.cash/tx/4740fd4b638059314a212eeedbb16c204b862729a123e9502309979b86f360a6)

## Chipnet run, StampMinter2 + 2 lanes per stall (19 Nov 2026)
- Genesis: [`c8f9be79…`](https://chipnet.imaginary.cash/tx/c8f9be79320fe95370fc4a88ad7d2b5f5bf2b0b1fbbcc195fdd5923a2fe05ccc) (8 minter coins + vault)
- Stamps [`1df23b2f…`](https://chipnet.imaginary.cash/tx/1df23b2f4990586f1545489d588e6286fdbf1c208719575a1ff3606ad20e51ee) · [`0542ac61…`](https://chipnet.imaginary.cash/tx/0542ac61b4cb611c58197001657722c556e5990974a16a9a48f9ba4bb34c2165) · [`7e1a8b70…`](https://chipnet.imaginary.cash/tx/7e1a8b70c09698c2a19b81a2dd23c16f37d527b1057dad2241b6f5d56be8db66) · claim + trophy [`9056ff5d…`](https://chipnet.imaginary.cash/tx/9056ff5dc5d2ab2569fd2188d311e5166b9b817f1d0c44a1b11b71167a09d9e1)
- **Member-price stamp** using that trophy (1,800 instead of 2,000 sats, trophy returned): [`14875f6d…`](https://chipnet.imaginary.cash/tx/14875f6d30c42372342efc84372e133c9061986be0074cc5197723f7276dac28)

## Chipnet run (17 Nov 2026, original StampMinter, still used by `xo/`)
- Genesis: [`aa5c20f5…`](https://chipnet.imaginary.cash/tx/aa5c20f53240528ab3fd4ea581cf6a8a42c28cdbdc2a43ffe3035239478dbffc)
- Stamps: [`abaafd90…`](https://chipnet.imaginary.cash/tx/abaafd903a316c9290013e4698ce974cc687195552fc5f3b6c6c0ff3f93de9b9) · [`b3d2ae3b…`](https://chipnet.imaginary.cash/tx/b3d2ae3bd6fcf910ee9f6798620dc10a3a321ce816a5b01205d166dd9fc1c292) · [`a4d05c49…`](https://chipnet.imaginary.cash/tx/a4d05c49b719b044196134335a4af6f4cca38d6329f5b79bebbf31cc6a113aa9)
- Claim + trophy: [`33d11924…`](https://chipnet.imaginary.cash/tx/33d119246e891151d6735d0159392e7c30b6eda67e84f33af8fd98f52b9c93b9)

## Real-wallet tests of the new features (Selene, chipnet, 20 Nov 2026)
- **Organizer page:** Selene paired over WizardConnect on `#/organize`, then signed the genesis of "Selene organizer test": 3 stalls × 2 lanes plus the vault. Genesis: [`c2ba873d…`](https://chipnet.imaginary.cash/tx/c2ba873dd6f615ca1cb36d531beebe0c7c4e85fde1f852a74262cb91f8b3c197). The share link it produced loaded with the community-rally warning, and the wallet session carried over.
- **Proof of presence:** on the presence rally, the buyer panel showed Selene's code (pkh + lane coin), a second tab running `#/device/1` signed it, the panel verified it locally, and Selene approved the purchase showing the `01 ‖ pkh` stamp: [`732fc91b…`](https://chipnet.imaginary.cash/tx/732fc91b55ba015d5317c7798cf71fcf544811b7310957a802dba5f4d6f1c58b).

## Real-wallet test (Selene, chipnet, 17 Nov 2026)
Selene Wallet connected over WizardConnect, signed three purchases and the claim. The burned stamps (`01`, `02`, `03`) and the minted trophy (`00`) showed up in Selene's own signing screen:
stamps [`165bffba…`](https://chipnet.imaginary.cash/tx/165bffba2adb6b96da8c8b8d7d4ec46cbe358a610d4ea8c0b5ce6125aa685a01) · [`fc2d8064…`](https://chipnet.imaginary.cash/tx/fc2d806403a491e273f628dcb1505a60144f5109cc8090ce6563752ad3b5ef06) · [`df38f343…`](https://chipnet.imaginary.cash/tx/df38f3433de31d6776f1e24d16917eddf696ed064945659261830feb8fec7366) · claim + trophy [`91105443…`](https://chipnet.imaginary.cash/tx/91105443be446460b233c75db2ed03e546371557ea620cbdf634e929a2cccff3).

## Stack
CashScript 0.14 · libauth · WizardConnect (`@wizardconnect/react`) · React + Vite · Electrum (Fulcrum) · BCMR metadata (optional, at deploy time).

## Bounties in this repo
- **FoldingCash Reward Claims:** [`claims/`](claims/README.md). Pull-based Merkle claims built on a second, on-chain "claimed" tree, run on real FoldingCash distro data on chipnet.
- **Build with XO / Migrate to XO:** [`xo/`](xo/README.md). Jelajah's buy-and-stamp step as an XO template that assembles byte-for-byte to the live StampMinter covenant, executed through the XO engine on chipnet.

## Not yet
- Prices and rewards in PUSD (ParyonUSD).
- An XO follow-up action for the claim.
- Merkle pull-claims for rallies with thousands of people.
