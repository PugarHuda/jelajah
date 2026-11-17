# Jelajah

![The four Jelajah Jogja stamps and the trophy](public/stamps.png)

**Live demo:** https://pugarhuda.github.io/jelajah/ · **Deck (Widget Factory template):** https://pugarhuda.github.io/jelajah/deck.pdf

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

### Threat model
| Attack | Why it fails |
|---|---|
| A stall buys from itself to farm rewards | A set needs N different stalls, and the deploy script enforces **reward < the cheapest full set**, so farming loses money. |
| Buying second-hand stamps to claim | Stamps can be traded as collectibles, but the reward and trophy always go to the pkh that bought them. |
| The organizer runs off with the pool | The vault only pays out through `claim()` until `endTime`. |
| Extra stamps minted / a minter drained | Minter value and token must come back unchanged, and no other output may carry tokens. |
| A trophy reused as a stamp | Trophy id `00` can never satisfy `id > prev` starting from 0. |
| **Every stall in a set colludes** with a buyer and refunds them off-chain | **Not prevented on chain.** The buyer pays only fees, so the pool can be drained one reward at a time. The price rule only stops a single cheater. A merchant co-signature doesn't help (the merchants are the colluders), and one claim per pkh is beaten by using many addresses. The real fix is governance: **the stalls fund the pool themselves** in proportion, so colluding only drains their own money. (In the demo every stall payment goes to the organizer, who also funds the pool, so the risk is zero.) An optional organizer co-signature on each stamp is the centralized alternative. |

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
```
`scripts/rally.config.json` sets the stalls, prices, reward and duration. `--merchant-address` pays real stall wallets.

## Chipnet run (17 Nov 2026)
- Genesis: [`aa5c20f5…`](https://chipnet.imaginary.cash/tx/aa5c20f53240528ab3fd4ea581cf6a8a42c28cdbdc2a43ffe3035239478dbffc)
- Stamps: [`abaafd90…`](https://chipnet.imaginary.cash/tx/abaafd903a316c9290013e4698ce974cc687195552fc5f3b6c6c0ff3f93de9b9) · [`b3d2ae3b…`](https://chipnet.imaginary.cash/tx/b3d2ae3bd6fcf910ee9f6798620dc10a3a321ce816a5b01205d166dd9fc1c292) · [`a4d05c49…`](https://chipnet.imaginary.cash/tx/a4d05c49b719b044196134335a4af6f4cca38d6329f5b79bebbf31cc6a113aa9)
- Claim + trophy: [`33d11924…`](https://chipnet.imaginary.cash/tx/33d119246e891151d6735d0159392e7c30b6eda67e84f33af8fd98f52b9c93b9)

## Real-wallet test (Selene, chipnet, 17 Nov 2026)
Selene Wallet connected over WizardConnect, signed three purchases and the claim. The burned stamps (`01`, `02`, `03`) and the minted trophy (`00`) showed up in Selene's own signing screen:
stamps [`165bffba…`](https://chipnet.imaginary.cash/tx/165bffba2adb6b96da8c8b8d7d4ec46cbe358a610d4ea8c0b5ce6125aa685a01) · [`fc2d8064…`](https://chipnet.imaginary.cash/tx/fc2d806403a491e273f628dcb1505a60144f5109cc8090ce6563752ad3b5ef06) · [`df38f343…`](https://chipnet.imaginary.cash/tx/df38f3433de31d6776f1e24d16917eddf696ed064945659261830feb8fec7366) · claim + trophy [`91105443…`](https://chipnet.imaginary.cash/tx/91105443be446460b233c75db2ed03e546371557ea620cbdf634e929a2cccff3).

## Stack
CashScript 0.14 · libauth · WizardConnect (`@wizardconnect/react`) · React + Vite · Electrum (Fulcrum) · BCMR metadata (optional, at deploy time).

## Not yet
- Prices and rewards in PUSD (ParyonUSD).
- An XO template for buy-and-stamp and claim.
- Merkle pull-claims for rallies with thousands of people.
