# Jelajah ID: one identity across Bitcoin Cash and Nostr

Jelajah ID links a BCH address and a Nostr key. Each key vouches for the other, and no server, database or identity provider is involved. Anyone can check a link using only public relays and the BCH chain.

## How it works

1. **BCH side.** The wallet spends a coin *from the claimed address*. The proof transaction's OP_RETURN is NIP-39's verification text:

   `Verifying that I control the following Nostr public key: npub1…`

   Only the holder of that address's key could have signed the spend. (v1 proofs committed `"JLID" ‖ sha256(statement) ‖ nostr pubkey`; they still verify.)
2. **Nostr side.** The Nostr key signs a replaceable event:
   - kind `30078`, `d` tag `jelajah-bch-link`;
   - content is the statement: *"Jelajah ID v1: the Bitcoin Cash address … and the Nostr key … belong to the same person."*;
   - tagged `["i", "bch:<address>", "<proof txid>"]`, so the link can be found **by Nostr key or by BCH address**.
3. **Verification** (`verifyLink` in `src/lib/identity.js`) checks four things:
   - the event's Schnorr signature;
   - that the statement matches the address and key;
   - that the proof tx's OP_RETURN names this Nostr key (the NIP-39 text, or the v1 commitment);
   - that the proof tx spent a coin of the claimed P2PKH address, signed `SIGHASH_ALL` (so the key committed to the OP_RETURN; an `ANYONECANPAY` coinjoin signature proves nothing);
   - that every fetched tx hashes to its txid (a lying server can't substitute one).

   Neither private key ever crosses networks.
4. **Standard NIP-39 claim.** The same link is also published in the key's NIP-39 list (kind `10011`) as `["i", "bch:q…", "tx:<proof txid>"]`. This is the on-chain proof form of the `bch` claim type in [TwinKey's spec](https://github.com/samizdatproject/twinkey/blob/main/SPEC.md). Publishing keeps the list's other claims. **Interop check:** TwinKey's live verifier, an independent implementation, shows our mainnet link as **✓ Verified link**: [lookup](https://samizdatproject.github.io/twinkey/?q=npub1x2uldr579mk849v4n80hwkw9ngfy35yrdnzjy6z894dt2u2w0ezsqnx6vk).
5. **Login** uses challenge and response. The app issues a random challenge. The user's Nostr key signs a one-off event (kind 27235) carrying it. The app checks the signature, the challenge and freshness, then looks up the verified BCH address. There is no password and no account.

## Live on mainnet

| | |
|---|---|
| Nostr | `npub1x2uldr579mk849v4n80hwkw9ngfy35yrdnzjy6z894dt2u2w0ezsqnx6vk` |
| BCH | `bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q` (the Jelajah organizer) |
| Proof tx (v2, NIP-39 text) | [e9137c1c…](https://blockchair.com/bitcoin-cash/transaction/e9137c1cc301a5e7179c3eafa48adb1fe460069f7ce53141a0a249c702345dd3) |
| NIP-39 list (kind 10011) | `8b7e74daf64f2f023dfc1176f6d55d7876613867631fc1eda201be574b9c9d2b` |
| Proof tx (v1) | [da731db2…](https://blockchair.com/bitcoin-cash/transaction/da731db2956c3ab85474339e96c338155073869cb7fcb40d1a26ce3cc0dd437f) |
| Nostr event | `c5c51c1e6a456af8e52a3a2748ea18abf63ab4aa6accbbcd3e090abec7a222a4` (damus, nos.lol) |

## Try it

- **App:** open `#/identity`. You can:
  - link your address with Selene through WizardConnect, signing with a NIP-07 extension or a browser key;
  - verify anyone by npub or by address, and see their rally stamps and trophies (reputation that travels with the identity);
  - pay a verified identity;
  - see who is verified in the stall dashboard (`#/stats`): collectors with a verified link get a **✓ Nostr** badge. On chipnet, the top collector `bchtest:qp497z…pkyjn` (5/5 stalls, a trophy) is linked: proof [71cf8731…](https://chipnet.imaginary.cash/tx/71cf87318d7f43335efbbbe2dc7cd0da8b9c1918b78b1e44c28b28e9b2640864);
  - log in.
- **Independent verifier (CLI):**

  ```
  node scripts/verify-identity.mjs npub1x2uldr579mk849v4n80hwkw9ngfy35yrdnzjy6z894dt2u2w0ezsqnx6vk
  node scripts/verify-identity.mjs bitcoincash:qqd2thqn52yy8j85fdk782gffdns9yqelulnlj6s3q
  ```

- **End-to-end demo:** `node scripts/identity-demo.mjs --network mainnet` runs proof → publish → discover both ways → login, and also tries a forged login.
- **Tests:** `node test/identity.mjs` (part of `npm run check`) runs offline against the real mainnet proof. It refuses:
  - an edited event;
  - another key re-signing the proof;
  - an attacker claiming the address with their own statement;
  - reuse of the proof for another address;
  - a missing proof tx;
  - a wrong or tampered login.

## Limits

- A link proves control at the time of the proof. If the address's key is later lost or sold, publish a new link event; it replaces the old one, because it is replaceable.
- Discovery depends on the relays carrying the event. Verification does not depend on trusting them.
