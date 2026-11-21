# Launch posts (draft, post on 21 Nov 2026 = H-1)

Fill in `https://dorahacks.io/buidl/51463` after submitting. Attach `public/stamps.png` (or a screen recording of a purchase) to the first X post.

## X thread (@BangDropID)

**1/**
Jelajah is live on Bitcoin Cash mainnet 🍜☕🍢

A stamp rally for Jogja street food: pay a warung, and its stamp NFT is printed in the same transaction. Collect 3, burn them, get a reward + a trophy.

No sign-up. No server. No one holds the prize money.
https://jelajah-bch.vercel.app
#BCHBLAZE2026

**2/**
How the stall's covenant works: the stamp only leaves if the stall got paid at least its price, in that same tx. Every stamp is proof of a real, paid visit.

The reward vault loops over your stamps (2026 VM loops) and checks 3 different stalls, all bought by you. Then it pays you and mints your trophy.

**3/**
New: your trophy is a membership card 🏆

Show it to any stall and the covenant charges you the member price, then hands the trophy straight back in the same tx. A traded trophy doesn't work, and neither does keeping the discount while sending the trophy away. All enforced on chain.

**4/**
"What if the stalls collude and refund the buyer?"

The live mainnet rally is a levy rally: every stamp pays a levy into the pool, and one set's levies cover its own reward. Colluders just pay themselves. Anyone can merge levies into the vault, unsigned, and it can only grow.

**5/**
New: Jelajah ID 🪪 links your BCH address to your Nostr key. Each key vouches for the other: a NIP-39 claim plus an on-chain proof. No server.

TwinKey's independent verifier already shows our mainnet link as ✓ Verified. Your stamps and trophies travel with your npub, and you can log in with Nostr.

**6/**
Also in:
🔔 a stall till that rings on every paid stamp
🧩 buy → claim as an XO template
🌱 FoldingCash Merkle claims on mainnet
🇮🇩 Bahasa Indonesia / English

Code + attack tests: https://github.com/PugarHuda/jelajah
Vote / BUIDL: https://dorahacks.io/buidl/51463

## Telegram (BCH BLAZE group)

Halo semua! Update dari **Jelajah** (stamp rally di Bitcoin Cash, dari Jogja) 🍜

✅ Live di **BCH mainnet**: bayar warung, stamp NFT tercetak di transaksi yang sama. Kumpulkan 3, bakar, dapat hadiah + trofi
🏆 **Trofi = kartu member**: harga lebih murah di semua warung, dan trofinya langsung kembali (dijamin covenant)
🛡️ **Levy rally, sekarang live di mainnet**: setiap set membiayai hadiahnya sendiri, jadi warung yang berkolusi tidak bisa menguras pool
🔔 Layar **kasir** untuk warung: berbunyi tiap ada stamp terbayar
🧩 Alur lengkap (beli → klaim) sebagai template **XO**, sama byte-per-byte dengan covenant yang live
🌱 Klaim Merkle **FoldingCash** di mainnet (pull, bukan push)
📊 Dasbor penjualan per warung langsung dari chain · UI Bahasa Indonesia / English
🪪 **Jelajah ID**: alamat BCH ↔ kunci Nostr (NIP-39 + bukti on-chain), terverifikasi juga oleh verifier TwinKey; stamp & trofi ikut ke npub-mu
🧪 Kontrak StampCard di **SolidCash**, siklus penuh di mainnet (deploy → 3 kunjungan → redeem) + PR upstream ke solidcash

Demo: https://jelajah-bch.vercel.app
Code: https://github.com/PugarHuda/jelajah
BUIDL: https://dorahacks.io/buidl/51463

Feedback sangat diterima, terutama dari yang sudah coba pakai Selene / Paytaca 🙏

**English version:**
Hi all! Update from **Jelajah**, a stamp rally on Bitcoin Cash from Jogja 🍜
✅ Live on mainnet: pay a stall and its stamp NFT is minted in the same tx. Collect 3, burn them, get paid back + a trophy
🏆 Trophy = membership card: member price at every stall, and the trophy comes straight back (covenant-enforced)
🛡️ Levy rally, now live on mainnet: each set funds its own reward, so colluding stalls can't drain the pool
🔔 A till for stalls that rings on every paid stamp
🧩 Buy → claim as an XO template, byte-exact to the live covenants
🌱 FoldingCash Merkle pull-claims on mainnet
📊 Live per-stall sales from the chain · ID/EN UI
🪪 Jelajah ID: BCH address ↔ Nostr key (NIP-39 + on-chain proof), also ✓ in TwinKey's independent verifier
🧪 A StampCard contract in SolidCash, full lifecycle on mainnet (deploy → 3 visits → redeem) + an upstream PR
Demo / code / BUIDL links above.
