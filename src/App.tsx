import { useCallback, useEffect, useRef, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import qrcode from 'qrcode-generator';
import { hexToBin, binToHex, cashAddressToLockingBytecode, secp256k1, sha256, generatePrivateKey, encodePrivateKeyWif, decodePrivateKeyWif, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import { TransactionBuilder, SignatureTemplate, type Utxo } from 'cashscript';
import { generateSecretKey, getPublicKey, finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, NIP39_KIND, rallyEvent, findRallies, buildProofTx, linkEvent, nip39Event, findVerified, loginChallenge, loginEvent, checkLogin } from './lib/identity.js';
import { rally, provider, minters, vault, rallyLink, fromLink, passportFromLink, officialRallies, rallyFromPayload, type Merchant, type Rally } from './chain';
import { bcmrRegistry, rallyContracts, genesisMatches, stallSales, isVoucher, buildStamp, buildClaim, isRallyNft, rallyStats, mergeLevies, checkRallyConfig, genesisNeed, planRally, buildGenesis, presenceMessage, signPresence, presenceCode, parsePresenceCode, pickLane, buildReclaim, buildAddStall, buildPassportClaim, isTrophyOf } from './lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, addressOf, receiveZeroCoin, type Coin } from './wallet';
import { Stamp, Trophy } from './Stamp';
import { SLIDES_URL, REPO_URL, VOTE_ADDRESS } from './links';

// ponytail: one clock reading per page load; every route change here reloads the page anyway
const LOADED_AT = Date.now() / 1000;
const sats = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} sats`;

// Rupiah hint next to sat prices. One public price lookup, nothing about the user is sent; no rate -> no hint.
let idrPerBch: number | null = null;
const idrRate = fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=idr')
  .then((r) => r.json()).then((j) => { idrPerBch = j['bitcoin-cash']?.idr ?? null; }).catch(() => {});
const rupiah = (n: number | bigint) => idrPerBch === null ? ''
  : ` ≈ Rp${Math.round(Number(n) / 1e8 * idrPerBch).toLocaleString('id-ID')}`;

// UI language: ?lang=id|en, then the saved choice, then the browser. ponytail: inline pairs, no i18n lib for two languages.
const ID = (() => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('lang'); } catch { /* private mode */ }
  const l = new URLSearchParams(location.search).get('lang') ?? saved ?? navigator.language;
  return l.toLowerCase().startsWith('id');
})();
document.documentElement.lang = ID ? 'id' : 'en';
const tr = (en: string, id: string) => (ID ? id : en);
function switchLang() {
  try { localStorage.setItem('lang', ID ? 'en' : 'id'); } catch { /* private mode */ }
  const u = new URL(location.href);
  u.searchParams.set('lang', ID ? 'en' : 'id');
  location.href = u.href;
  if (u.hash) setTimeout(() => location.reload());
}
// what the buyer pays for one stamp: the stall's (member) price plus the levy that goes to the pool
const cost = (m: Merchant, member: boolean, voucher = false) => (member ? m.memberPrice! : m.price) + (rally.levy ?? 0) - (voucher ? rally.sponsor!.value : 0);
const stallOf = (c: Coin) => parseInt(c.utxo.token!.nft!.commitment.slice(0, 2), 16);

export default function App() {
  const stallFromHash = window.location.hash.match(/^#\/stall\/(\d+)/)?.[1];
  if (stallFromHash) return <StallPoster m={rally.merchants.find((x) => x.id === Number(stallFromHash))} />;
  if (window.location.hash === '#/stats') return <Stats />;
  if (window.location.hash === '#/organize') return <Organize />;
  if (window.location.hash.startsWith('#/device')) return <Device />;
  if (window.location.hash === '#/reclaim') return <Reclaim />;
  if (window.location.hash === '#/solidcash') return <SolidCashPage />;
  if (window.location.hash === '#/identity') return <IdentityPage />;
  if (window.location.hash.startsWith('#/till/')) return <Till />;
  if (window.location.hash.startsWith('#/u/')) return <Profile />;
  if (window.location.hash === '#/rallies') return <Rallies />;
  if (window.location.hash === '#/story') return <Story />;
  if (window.location.hash.startsWith('#/gift')) return <Gift />;
  if (window.location.hash === '#/passport' && passportFromLink) return <PassportPage />;
  if (window.location.hash === '#/art') return ( // press image: every stamp + the trophy
    <main className="art">{rally.merchants.map((m) => <Stamp key={m.id} m={m} inked size={220} />)}<Trophy name={rally.name} size={220} /></main>
  );
  return <Rally />;
}

function Rally() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const [coins, setCoins] = useState<Coin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ label: string; txid: string }[]>([]);
  const [pool, setPool] = useState<bigint | null>(null);
  const [idr, setIdr] = useState(idrPerBch !== null);
  useEffect(() => { idrRate.then(() => setIdr(idrPerBch !== null)); }, []); // re-render once the rate lands
  useEffect(() => { if (import.meta.env.DEV) (window as unknown as { __wc: unknown }).__wc = wc; }, [wc]); // debugging aid in dev only
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const connected = !!lock; // connected AND the wallet shared its keys
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected" without a re-render; poll until they do
    if (wc.state !== 'connected' || connected) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, connected]);

  const refresh = useCallback(async () => {
    // levy rallies keep unmerged levy coins next to the vault coin; count them, they merge before a claim
    vault.getUtxos().then((u) => setPool(u.reduce((s, x) => s + x.satoshis, 0n))).catch(() => {});
    if (connected) setCoins(await walletCoins(wc.manager!));
  }, [connected, wc.manager]);

  useEffect(() => {
    // polling the chain is syncing with an external system; refresh() only sets state once Electrum answers
    // eslint-disable-next-line react/set-state-in-effect
    refresh();
    const t = setInterval(refresh, 12_000);
    return () => clearInterval(t);
  }, [refresh]);

  const nfts = coins.filter((c) => isRallyNft(rally, c.utxo));
  const mine = (c: Coin) => lock && c.utxo.token!.nft!.commitment.slice(2, 42) === hex(lock.slice(3, 23)); // id ‖ pkh (‖ tier)
  const stamps = nfts.filter((c) => stallOf(c) > 0 && mine(c));
  const trophies = nfts.filter((c) => stallOf(c) === 0);
  const member = (rally.minter ?? 1) >= 2 && trophies.some(mine); // own trophy -> member price at every stall
  const hasVoucher = coins.some((c) => isVoucher(rally, c.utxo)); // a sponsor's voucher pays part of the next stamp
  const collected = new Set(stamps.map(stallOf));
  const bch = coins.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
  const ready = collected.size >= rally.needed;
  // bonus tier: enough different stalls -> the claim takes the bigger reward (the vault forces it when the stamps are there)
  const bonus = !!rally.bonusNeeded && collected.size >= rally.bonusNeeded;
  const prize = BigInt(bonus ? rally.bonusReward! : rally.reward);
  const burn = bonus ? rally.bonusNeeded! : rally.needed;
  const rewardsLeft = pool === null ? null : Number((pool - 1000n) / BigInt(rally.reward)); // vault keeps 1000 sats dust

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label); setError(null);
    try {
      const txid = await fn();
      setLog((l) => [{ label, txid }, ...l]);
      [1500, 5000].forEach((ms) => setTimeout(refresh, ms)); // the indexer can lag the broadcast
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  // presence stalls: pick the lane coin first, the stall's code is bound to it (single use)
  const [askPresence, setAskPresence] = useState<{ m: Merchant; lane: Utxo } | null>(null);
  const buy = (m: Merchant, presence?: string, lane?: Utxo) => (m.presenceKey && !presence)
    ? void pickLane(rally, minters[m.id]).then((l) => (l ? setAskPresence({ m, lane: l }) : setError(tr('This stall is not open', 'Warung ini belum buka'))))
    : run(`${m.emoji} ${tr('Stamped at', 'Dapat stamp di')} ${m.name}`, async () => {
    const fresh = await walletCoins(wc.manager!); // never build on a stale or not-yet-loaded coin list
    const myTrophy = (rally.minter ?? 1) >= 2 ? fresh.find((c) => isRallyNft(rally, c.utxo) && stallOf(c) === 0 && mine(c)) : undefined;
    const voucher = fresh.find((c) => isVoucher(rally, c.utxo));
    const price = sats(cost(m, !!myTrophy, !!voucher));
    const { builder, inputs } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: lock!, coins: fresh.filter((c) => !c.utxo.token), trophy: myTrophy, presence: presence ? hexToBin(presence) : undefined, lane, voucher });
    return signAndSend(wc.manager!, builder, inputs, myTrophy
      ? tr(`Show your trophy, pay ${m.name} the member price ${price} and get its stamp`, `Tunjukkan trofimu, bayar ${m.name} harga member ${price} dan dapat stamp-nya`)
      : tr(`Pay ${m.name} ${price} and get its Jelajah stamp`, `Bayar ${m.name} ${price} dan dapat stamp Jelajah-nya`));
  });

  const claim = () => run(tr('🏆 Set claimed: reward + trophy', '🏆 Set diklaim: hadiah + trofi'), async () => {
    const fresh = await walletCoins(wc.manager!);
    const hexPkh = hex(lock!.slice(3, 23));
    // unsigned, so no wallet prompt; if it fails (e.g. a racing merge) the claim still uses the current vault coin
    const vaultUtxo = (await mergeLevies({ rally, provider, vault }).catch(() => null)) ?? undefined;
    const { builder, inputs } = await buildClaim({
      rally, provider, vault, buyerLock: lock!, vaultUtxo,
      stamps: fresh.filter((c) => isRallyNft(rally, c.utxo) && stallOf(c) > 0 && c.utxo.token!.nft!.commitment.slice(2) === hexPkh),
      coins: fresh.filter((c) => !c.utxo.token), bonus,
    });
    return signAndSend(wc.manager!, builder, inputs, tr(`Burn ${burn} stamps for ${sats(prize)} + a trophy`, `Bakar ${burn} stamp untuk ${sats(prize)} + trofi`));
  });

  return (
    <>
      <Banner />
      <header className="top">
        <a className="brand" href="#"><img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={30} height={30} /> Jelajah</a>
        <span className={`pill ${rally.network}`}>{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'}</span>
        <div className="grow" />
        <button className="ghost lang" onClick={switchLang} title={tr('Bahasa Indonesia', 'English')}>{ID ? 'EN' : 'ID'}</button>
        {connected ? (
          <button className="ghost" onClick={wc.disconnect} title={tr('Disconnect', 'Putuskan')}>
            {wc.walletName ?? 'Wallet'} · {sats(bch)}
          </button>
        ) : (
          <button className="primary" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>
            {wc.state === 'connecting' ? tr('Waiting for wallet…', 'Menunggu wallet…') : wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}
          </button>
        )}
      </header>
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri}
          title={tr('Connect with WizardConnect', 'Hubungkan lewat WizardConnect')} subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />
      )}

      <main>
        <section className="hero">
          <p className="eyebrow">{rally.name} · {tr('a stamp rally on Bitcoin Cash', 'stamp rally di Bitcoin Cash')}</p>
          {ID
            ? <h1>Jajan di {rally.needed} warung.<br />Kumpulkan {rally.needed} stamp.<br /><em>Dapat hadiah.</em></h1>
            : <h1>Eat at {rally.needed} stalls.<br />Collect {rally.needed} stamps.<br /><em>Get rewarded.</em></h1>}
          {ID ? (<>
            <p className="lede">
              Bayar di warung dan stamp NFT-nya tercetak <b>di transaksi yang sama</b>. Bakar satu set lengkap, kontrak rally
              membayarmu {sats(rally.reward)} dan mencetak trofimu. Tanpa daftar, tanpa server, tanpa ada yang memegang uang hadiah.
            </p>
            <p className="muted small">Bukan kartu loyalitas satu toko: banyak warung, satu pool hadiah bersama, dan hanya stamp dari warung <b>berbeda</b> yang dihitung.</p>
          </>) : (<>
            <p className="lede">
              Paying a stall prints its stamp NFT <b>in the same transaction</b>. Burn a full set and the rally's
              contract pays you {sats(rally.reward)} and mints your trophy. No sign-up, no server, no one holding the prize money.
            </p>
            <p className="muted small">Not one shop's loyalty card: many stalls, one shared prize pool, and only stamps from <b>different</b> stalls count.</p>
          </>)}
        </section>

        {LOADED_AT > rally.endTime && (
          <section className="warn" role="note">
            <b>⏰ {tr('This rally has ended', 'Rally ini sudah berakhir')}</b> ({new Date(rally.endTime * 1000).toLocaleDateString(ID ? 'id-ID' : 'en-US')}). {tr('Claims still work until the organizer takes the pool back.', 'Klaim masih bisa sampai penyelenggara mengambil kembali pool-nya.')}
          </section>
        )}
        {fromLink && (
          <section className="warn" role="note">
            <b>⚠ {tr('Community rally from a link: not the official Jelajah demo.', 'Rally komunitas dari sebuah link: bukan demo resmi Jelajah.')}</b>{' '}
            {tr('Anyone can create one. Only buy if you trust whoever shared it. Your payments go to:', 'Siapa pun bisa membuatnya. Beli hanya kalau kamu percaya pada yang membagikannya. Pembayaranmu masuk ke:')}
            <ul>{rally.merchants.map((m) => <li key={m.id}>{m.emoji} {m.name}: <code>{addressOf(hexToBin(m.lock))}</code></li>)}</ul>
            <a href={location.pathname}>{tr('Go to the official rally', 'Ke rally resmi')}</a>
          </section>
        )}

        <section className="board" aria-label={tr('Stalls', 'Warung')}>
          <div className="board-head">
            <div>
              <h2>{tr('Stalls', 'Warung')}</h2>
              <p className="muted">{tr(`Any ${rally.needed} different stalls complete the set.`, `${rally.needed} warung berbeda mana pun melengkapi satu set.`)}</p>
            </div>
            <div className="progress" aria-live="polite">
              <b>{Math.min(collected.size, rally.needed)}</b>/{rally.needed}
              <span className="muted"> stamp{ID ? '' : 's'}</span>
            </div>
          </div>
          <div className="stalls">
            {rally.merchants.map((m) => {
              const have = collected.has(m.id);
              return (
                <article key={m.id} id={`stall-${m.id}`} className={`stall ${have ? 'have' : ''}`} style={{ '--c': m.color } as React.CSSProperties}>
                  <Stamp m={m} inked={have} />
                  <h3>{m.name}</h3>
                  <p className="muted small">{ID ? m.taglineId ?? m.tagline : m.tagline}</p>
                  {m.place && <a className="small place" href={mapUrl(m.place)} target="_blank" rel="noreferrer">📍 {m.place}</a>}
                  {idr && <p className="muted small idr">{sats(cost(m, member))}{rupiah(cost(m, member))}</p>}
                  <button className={have ? 'ghost' : 'primary'} disabled={!connected || !!busy}
                    onClick={() => buy(m)} title={connected ? undefined : tr('Connect your wallet first', 'Hubungkan wallet dulu')}>
                    {busy?.endsWith(` ${m.name}`) ? tr('Approve in wallet…', 'Setujui di wallet…')
                      : `${have ? tr('Again', 'Lagi') : tr('Buy', 'Beli')} · ${sats(cost(m, member, hasVoucher))}${member ? ' ★' : ''}${hasVoucher ? ' 🎟' : ''}`}
                  </button>
                </article>
              );
            })}
          </div>

          <div className={`claim ${ready ? 'ready' : ''}`}>
            <div>
              <h3>{ready ? tr('Your set is complete', 'Set kamu sudah lengkap') : tr('Complete the set', 'Lengkapi set')}</h3>
              <p className="muted small">
                {tr(`Burns one stamp from each of ${rally.needed} stalls → ${sats(rally.reward)}${rupiah(rally.reward)} + a ${rally.name} Trophy NFT.`,
                  `Membakar satu stamp dari tiap ${rally.needed} warung → ${sats(rally.reward)}${rupiah(rally.reward)} + NFT Trofi ${rally.name}.`)}
                {rally.bonusNeeded && tr(` Bonus tier: ${rally.bonusNeeded} different stalls → ${sats(rally.bonusReward!)}${rupiah(rally.bonusReward!)}.`,
                  ` Tingkat bonus: ${rally.bonusNeeded} warung berbeda → ${sats(rally.bonusReward!)}${rupiah(rally.bonusReward!)}.`)}
                {rewardsLeft !== null && tr(` ${Math.max(rewardsLeft, 0)} rewards left in the pool.`, ` Sisa ${Math.max(rewardsLeft, 0)} hadiah di pool.`)}
              </p>
            </div>
            <button className="primary big" disabled={!ready || !!busy} onClick={claim}>
              {busy?.startsWith('🏆') ? tr('Approve in wallet…', 'Setujui di wallet…') : tr(`Claim ${bonus ? 'bonus ' : ''}${sats(prize)} + trophy`, `Klaim ${bonus ? 'bonus ' : ''}${sats(prize)} + trofi`)}
            </button>
          </div>
          {!connected && <p className="hint">{tr("Connect a wallet (Selene, Paytaca, Cashonize) to start. Each stamp costs the stall's price plus a tiny network fee.", 'Hubungkan wallet (Selene, Paytaca, Cashonize) untuk mulai. Tiap stamp seharga warungnya ditambah biaya jaringan yang sangat kecil.')}</p>}
          {rally.sponsor && (
            <p className="hint">🎟 {tr(`Sponsored by ${rally.sponsor.name}: a voucher takes ${sats(rally.sponsor.value)} off a stamp, and the stall still gets its full price.`,
              `Disponsori ${rally.sponsor.name}: satu voucher memotong ${sats(rally.sponsor.value)} dari harga stamp, dan warung tetap dibayar penuh.`)}{hasVoucher && tr(' You hold a voucher.', ' Kamu punya voucher.')}</p>
          )}
          {(rally.minter ?? 1) >= 2 && (
            <p className="hint">{member
              ? tr('★ You hold a trophy: every stall gives you its member price. Your trophy is shown to the stall\'s covenant and comes straight back.',
                '★ Kamu punya trofi: semua warung memberimu harga member. Trofimu ditunjukkan ke covenant warung lalu langsung kembali.')
              : tr('★ Finish a set and your trophy becomes a membership card: a lower price at every stall, enforced on chain.',
                '★ Selesaikan satu set dan trofimu jadi kartu member: harga lebih murah di semua warung, dijamin di chain.')}</p>
          )}
          {rally.minter === 3 && (
            <p className="hint">{tr(`Each stamp includes a ${sats(rally.levy!)} levy that goes straight into the reward pool, so every set funds its own reward and colluding stalls can't drain it.`,
              `Tiap stamp sudah termasuk levy ${sats(rally.levy!)} yang langsung masuk pool hadiah, jadi setiap set membiayai hadiahnya sendiri dan warung yang berkolusi tidak bisa mengurasnya.`)}</p>
          )}
          {askPresence && lock && <PresencePanel m={askPresence.m} lane={askPresence.lane} buyerPkh={hex(lock.slice(3, 23))} onClose={() => setAskPresence(null)}
            onSig={(sig) => { const { m, lane } = askPresence; setAskPresence(null); buy(m, sig, lane); }} />}
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        {trophies.length > 0 && (
          <section className="shelf">
            <h2>{tr('Trophy shelf', 'Rak trofi')}</h2>
            <div className="trophies">{trophies.map((t) => <Trophy key={t.utxo.txid} name={rally.name} bonus={t.utxo.token!.nft!.commitment.length > 42} />)}</div>
          </section>
        )}

        {log.length > 0 && (
          <section className="log">
            <h2>{tr('Your transactions', 'Transaksimu')}</h2>
            <ul>{log.map((l) => <li key={l.txid}>{l.label} · <a href={explorerTx(l.txid)} target="_blank" rel="noreferrer">{l.txid.slice(0, 12)}…</a></li>)}</ul>
          </section>
        )}

        <section className="how">
          <h2>{tr('How it works', 'Cara kerjanya')}</h2>
          {ID ? (
            <ol>
              <li><b>Penyelenggara</b> mengunci pool hadiah di covenant. Pool itu tidak bisa ditarik sebelum rally berakhir.</li>
              <li><b>Setiap pembelian</b> lewat covenant warung: stamp hanya keluar kalau warung dibayar minimal seharga barangnya. Stamp membawa hash kunci pembeli.</li>
              <li><b>Vault</b> memeriksa satu per satu stamp yang kamu bakar: kategori sama, {rally.needed} warung berbeda, semuanya kamu yang beli. Lalu kamu dibayar dan trofimu dicetak.</li>
            </ol>
          ) : (
            <ol>
              <li><b>Organizer</b> locks the reward pool in a covenant. It can't take it back before the rally ends.</li>
              <li><b>Every purchase</b> runs through the stall's covenant: it only lets the stamp out if the stall got paid at least its price. Stamps carry the buyer's key hash.</li>
              <li><b>The vault</b> loops over the stamps you burn: same category, {rally.needed} different stalls, all bought by you. Then it pays you and mints your trophy.</li>
            </ol>
          )}
          <p className="muted small">
            {tr(`Anti-farming: the reward (${sats(rally.reward)}) is always lower than the cheapest full set, so a stall can't profit by buying from itself. Stamps can be traded as collectibles, but the reward always goes to whoever actually bought them.`,
              `Anti-farming: hadiah (${sats(rally.reward)}) selalu lebih kecil dari set termurah, jadi warung tidak bisa untung dengan membeli dari dirinya sendiri. Stamp boleh diperjualbelikan sebagai koleksi, tapi hadiah selalu jatuh ke pembeli aslinya.`)}
          </p>
          <dl className="tech">
            <dt>{tr('Token category', 'Kategori token')}</dt><dd><code>{rally.category}</code></dd>
            <dt>{tr('Reward vault', 'Vault hadiah')}</dt><dd><code>{vault.tokenAddress}</code></dd>
            <dt>Genesis</dt><dd><a href={explorerTx(rally.genesisTx)} target="_blank" rel="noreferrer">{rally.genesisTx.slice(0, 16)}…</a></dd>
            <dt>{tr('Stall dashboard', 'Dasbor warung')}</dt><dd><a href="#/stats" onClick={() => setTimeout(() => location.reload())}>{tr('Sales per stall, from the chain', 'Penjualan tiap warung, langsung dari chain')}</a></dd>
            <dt>SolidCash</dt><dd><a href="#/solidcash" onClick={() => setTimeout(() => location.reload())}>{tr('The stall card in SolidCash →', 'Kartu warung di SolidCash →')}</a></dd>
            <dt>Jelajah ID</dt><dd><a href="#/identity" onClick={() => setTimeout(() => location.reload())}>{tr('Link your BCH address with Nostr →', 'Tautkan alamat BCH-mu dengan Nostr →')}</a></dd>
            <dt>{tr('Organizers', 'Penyelenggara')}</dt><dd><a href="#/organize" onClick={() => setTimeout(() => location.reload())}>{tr('Open your own rally →', 'Buka rally-mu sendiri →')}</a> · <a href="#/reclaim" onClick={() => setTimeout(() => location.reload())}>{tr('reclaim after the end', 'ambil sisa pool')}</a></dd>
            <dt>{tr('Stall tills', 'Kasir warung')}</dt><dd>{rally.merchants.map((m) => <a key={m.id} href={`#/till/${m.id}`} onClick={() => setTimeout(() => location.reload())}>🔔 {m.name}</a>)}</dd>
            <dt>{tr('Story', 'Cerita')}</dt><dd><a href="#/story" onClick={() => setTimeout(() => location.reload())}>{tr('A day of roaming Jogja, in 6 panels →', 'Sehari menjelajah Jogja, dalam 6 panel →')}</a></dd>
            <dt>{tr('More rallies', 'Rally lain')}</dt><dd><a href="#/rallies" onClick={() => setTimeout(() => location.reload())}>{tr('Community rallies on Nostr →', 'Rally komunitas di Nostr →')}</a></dd>
            <dt>{tr('Gift', 'Hadiah')}</dt><dd><a href="#/gift" onClick={() => setTimeout(() => location.reload())}>{tr('Give a friend sats for their first stamp →', 'Beri teman sats untuk stamp pertamanya →')}</a></dd>
            <dt>{tr('Stall posters', 'Poster warung')}</dt><dd>{rally.merchants.map((m) => <a key={m.id} href={`#/stall/${m.id}`}>{m.emoji} {m.name}</a>)}</dd>
          </dl>
        </section>
      </main>
      <footer>Jelajah · {tr('stamp rallies on Bitcoin Cash · built for BCH BLAZE 2026', 'stamp rally di Bitcoin Cash · dibuat untuk BCH BLAZE 2026')} {lock && <span className="muted">· {tr('your stamp address', 'alamat stamp-mu')} {addressOf(lock, true)} · <a href={`#/u/${addressOf(lock)}`} onClick={() => setTimeout(() => location.reload())}>{tr('your collector page', 'halaman kolektormu')}</a></span>}</footer>
    </>
  );
}

function Banner() {
  return (
    <div className="banner">
      <b>BCH BLAZE 2026 entry</b>
      {SLIDES_URL && <a href={SLIDES_URL} target="_blank" rel="noreferrer">Slides</a>}
      {REPO_URL && <a href={REPO_URL} target="_blank" rel="noreferrer">Code</a>}
      {VOTE_ADDRESS && <span>Vote / donate: <code>{VOTE_ADDRESS}</code></span>}
      <span>Built from scratch during BLAZE (17–22 Nov 2026), no pre-existing code</span>
    </div>
  );
}

function StallPoster({ m }: { m?: Merchant }) {
  if (!m) return <main><p>Unknown stall.</p></main>;
  const url = `${location.origin}${location.pathname}${location.search}#stall-${m.id}`; // keep ?r= for link rallies
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return (
    <main className="poster" style={{ '--c': m.color } as React.CSSProperties}>
      <p className="eyebrow">{rally.name} · stamp rally</p>
      <Stamp m={m} inked size={180} />
      <h1>{m.name}</h1>
      {m.place && <a className="place" href={mapUrl(m.place)} target="_blank" rel="noreferrer">📍 {m.place}</a>}
      <p className="lede">{tr(`Pay here with Bitcoin Cash and get the ${m.name} stamp. Collect ${rally.needed} → get a reward.`, `Bayar di sini pakai Bitcoin Cash dan dapat stamp ${m.name}. Kumpulkan ${rally.needed} → dapat hadiah.`)}</p>
      <img className="qr" src={qr.createDataURL(8, 16)} alt={tr(`QR code to ${m.name}'s stall in the rally`, `Kode QR ke warung ${m.name} di rally`)} />
      <p className="muted small">{url}</p>
      <p className="small">{tr('For the stall:', 'Untuk warung:')} <a href={`#/till/${m.id}`} onClick={() => setTimeout(() => location.reload())}>🔔 {tr('open the till (rings on every sale)', 'buka kasir (berbunyi tiap ada penjualan)')}</a></p>
      <a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}

// ---- #/organize: open your own rally from the browser. The genesis is the same code the CLI uses (src/lib/tx.js),
// signed by the organizer's wallet over WizardConnect; the finished rally travels in its share link.
const PALETTE = ['#7a4a2b', '#c2410c', '#b91c1c', '#15803d', '#1d4ed8', '#7e22ce'];
type StallRow = { name: string; emoji: string; price: string; memberPrice: string; address: string; presenceKey?: string; place?: string };

function Organize() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [f, setF] = useState({ name: '', needed: '3', reward: '4000', rewardsInPool: '2', durationDays: '30', levy: '', bonusNeeded: '', bonusReward: '', bcmrUrl: '' });
  const [bcmrBody, setBcmrBody] = useState<string | null>(null);
  const [stalls, setStalls] = useState<StallRow[]>([
    { name: '', emoji: '🍜', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '☕', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '🍢', price: '5000', memberPrice: '4500', address: '' },
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [reclaimWif, setReclaimWif] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; category: string } | null>(null);
  const [listed, setListed] = useState<number | null>(null);
  async function list() { // optional: put the rally on #/rallies (a Nostr event carrying the share link's payload)
    setErr(null);
    try {
      const signer = await nostrSigner();
      const event = await signer.sign(rallyEvent({ ...made!, network: rally.network, r: new URL(link!).searchParams.get('r')! }));
      const pool = new SimplePool();
      const res = await Promise.allSettled(pool.publish(RELAYS, event));
      pool.close(RELAYS);
      setListed(res.filter((r) => r.status === 'fulfilled').length);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const payout = (address: string) => {
    if (!address.trim()) return lock ? binToHex(lock) : '76a914' + '00'.repeat(20) + '88ac'; // default: the organizer
    const r = cashAddressToLockingBytecode(address.trim());
    if (typeof r === 'string') throw new Error(tr(`Not a valid address: ${address}`, `Alamat tidak valid: ${address}`));
    return binToHex(r.bytecode);
  };
  const cfg = () => ({
    name: f.name.trim() || 'My rally', description: '', needed: Number(f.needed), reward: Number(f.reward),
    rewardsInPool: Number(f.rewardsInPool), durationDays: Number(f.durationDays), lanes: 2,
    ...(f.levy.trim() ? { levy: Number(f.levy) } : {}),
    ...(f.bonusNeeded.trim() ? { bonusNeeded: Number(f.bonusNeeded), bonusReward: Number(f.bonusReward) } : {}),
    merchants: stalls.map((s, i) => ({
      id: i + 1, name: s.name.trim() || `Stall ${i + 1}`, emoji: s.emoji || '⭐', tagline: '', color: PALETTE[i % PALETTE.length],
      price: Number(s.price), memberPrice: Number(s.memberPrice || s.price), lock: payout(s.address),
      ...(s.presenceKey?.trim() ? { presenceKey: s.presenceKey.trim().toLowerCase() } : {}),
      ...(s.place?.trim() ? { place: s.place.trim().slice(0, 80) } : {}),
    })),
  });
  let problem: string | null = null;
  let need = 0n;
  try { const c = cfg(); checkRallyConfig(c); need = genesisNeed(c); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  if (!problem && f.bcmrUrl.trim() && !/^https:\/\/[^\s]+\.json$/.test(f.bcmrUrl.trim())) problem = tr('The metadata URL must be https://… ending in .json', 'URL metadata harus https://… berakhiran .json');
  // organizer's fee in a levy rally, enforced by the contracts: levies above the reward stay in the pool until reclaim
  // (lower bound: RewardVault2.merge() lets at most 600 sats per input go to fees)
  const margin = f.levy.trim() ? Number(f.needed) * (Number(f.levy) - 600) - 600 - Number(f.reward) : 0;

  async function open() {
    setErr(null);
    try {
      const m = wc.manager!;
      const c = cfg();
      const coins = (await walletCoins(m)).filter((x) => !x.utxo.token);
      let base = coins.find((x) => x.utxo.vout === 0 && x.utxo.satoshis >= need);
      if (!base) { // the category id is the txid of a vout-0 coin: make one with a single send-to-self
        const total = coins.reduce((s, x) => s + x.utxo.satoshis, 0n);
        const fee = 200n + 160n * BigInt(coins.length);
        if (total - fee < need) throw new Error(tr(`Your wallet needs at least ${sats(need)} (has ${sats(total)})`, `Wallet-mu perlu minimal ${sats(need)} (ada ${sats(total)})`));
        setBusy(tr('Approve the preparation in your wallet…', 'Setujui transaksi persiapan di wallet…'));
        const tb = new TransactionBuilder({ provider });
        coins.forEach((x) => tb.addInput(x.utxo, x.unlocker));
        tb.addOutput({ to: lock!, amount: total - fee });
        const txid = await signAndSend(m, tb, coins, tr('Prepare one coin to open your Jelajah rally', 'Siapkan satu koin untuk membuka rally Jelajah'), 0);
        base = receiveZeroCoin(m, { txid, vout: 0, satoshis: total - fee });
      }
      // the rally's organizer key (for reclaim) is made here, not in the wallet: reclaim is then signed locally on #/reclaim
      const reclaimKey = generatePrivateKey();
      const r = planRally({ network: rally.network, cfg: c, organizerPub: binToHex(secp256k1.derivePublicKeyCompressed(reclaimKey) as Uint8Array), baseTxid: base.utxo.txid });
      // optional BCMR: wallets show the rally's names once the organizer hosts this file at that URL (hash locked in the genesis)
      const reg = f.bcmrUrl.trim() ? bcmrRegistry(r, f.bcmrUrl.trim(), 0, false) : null;
      const { builder } = buildGenesis({ provider, rally: r, rewardsInPool: c.rewardsInPool, base, organizerLock: lock!, bcmr: reg ?? undefined });
      const prize = sats(BigInt(r.reward) * BigInt(c.rewardsInPool));
      setBusy(tr('Approve the rally in your wallet…', 'Setujui pembukaan rally di wallet…'));
      const txid = await signAndSend(m, builder, [base], tr(`Open the rally "${r.name}" and lock ${prize} of prizes`, `Buka rally "${r.name}" dan kunci hadiah ${prize}`), 0);
      const wif = encodePrivateKeyWif(reclaimKey, rally.network === 'mainnet' ? 'mainnet' : 'testnet');
      try { localStorage.setItem(reclaimStoreKey(r as Rally), wif); } catch { /* shown below for backup anyway */ }
      setReclaimWif(wif);
      setMade({ name: r.name, category: r.category });
      if (reg) setBcmrBody(reg.body);
      setLink(await rallyLink({ ...r, genesisTx: txid } as Rally));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setStall = (i: number, k: keyof StallRow) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setStalls(stalls.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)));
  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('for organizers', 'untuk penyelenggara')}</p>
      <h1>{tr('Open your own rally', 'Buka rally-mu sendiri')}</h1>
      <p className="lede">{tr('Name the stalls, set prices and the prize. Your wallet signs one transaction that locks the prize pool in a covenant and gives every stall its stamp minter. Share the link it gives you.',
        'Isi warung, harga, dan hadiah. Wallet-mu menandatangani satu transaksi yang mengunci pool hadiah di covenant dan memberi tiap warung minter stamp-nya. Bagikan link yang muncul.')}</p>
      {link ? (
        <div className="claim ready">
          <div>
            <h3>{tr('Your rally is live', 'Rally-mu sudah live')} 🎉</h3>
            <p className="small" style={{ wordBreak: 'break-all' }}><a href={link}>{link}</a></p>
            <p className="muted small">{tr('The rally lives in this link: save it. Stall posters: open the link and add #/stall/1, #/stall/2, …', 'Rally ada di dalam link ini, simpan baik-baik. Poster warung: buka link lalu tambahkan #/stall/1, #/stall/2, …')}</p>
            {listed === null
              ? <button className="ghost" onClick={list}>{tr('List it on Nostr (shows on #/rallies)', 'Daftarkan di Nostr (muncul di #/rallies)')}</button>
              : <p className="small">✅ {tr(`Listed on ${listed} relays`, `Terdaftar di ${listed} relay`)} · <a href="#/rallies" onClick={() => setTimeout(() => location.reload())}>#/rallies</a></p>}
            {err && <p className="error" role="alert">{err}</p>}
            {bcmrBody && <p className="small">🪪 <a href={URL.createObjectURL(new Blob([bcmrBody], { type: 'application/json' }))} download="bcmr.json">{tr('Download bcmr.json', 'Unduh bcmr.json')}</a> {tr(`and host it, unchanged, at ${f.bcmrUrl.trim()}: wallets then show your rally's names (its hash is locked in the genesis).`, `lalu host apa adanya di ${f.bcmrUrl.trim()}: wallet akan menampilkan nama rally-mu (hash-nya terkunci di genesis).`)}</p>}
            {reclaimWif && <p className="warn small">🔑 <b>{tr('Back up your reclaim key.', 'Simpan kunci reclaim-mu.')}</b> {tr('It is the only way to take the leftover pool back after the rally ends (link + #/reclaim). It is also saved in this browser.', 'Hanya dengan kunci ini sisa pool bisa diambil setelah rally berakhir (link + #/reclaim). Kunci ini juga tersimpan di browser ini.')}<br /><code className="wrap">{reclaimWif}</code></p>}
          </div>
        </div>
      ) : (<>
        <div className="form">
          <label>{tr('Rally name', 'Nama rally')}<input value={f.name} onChange={set('name')} placeholder="Jelajah Malioboro" maxLength={40} /></label>
          <label>{tr('Stamps for a set', 'Stamp untuk satu set')}<input type="number" min={1} value={f.needed} onChange={set('needed')} /></label>
          <label>{tr('Reward per set (sats)', 'Hadiah per set (sats)')}<input type="number" min={1} value={f.reward} onChange={set('reward')} /></label>
          <label>{tr('Rewards to fund now', 'Jumlah hadiah didanai')}<input type="number" min={1} value={f.rewardsInPool} onChange={set('rewardsInPool')} /></label>
          <label>{tr('Days open', 'Lama (hari)')}<input type="number" min={1} value={f.durationDays} onChange={set('durationDays')} /></label>
          <label>{tr('Levy per stamp (sats, optional)', 'Levy per stamp (sats, opsional)')}<input type="number" min={0} value={f.levy} onChange={set('levy')} placeholder={tr('none', 'tanpa')} /></label>
          <label>{tr('Bonus tier: stalls (optional, needs a levy)', 'Tingkat bonus: jumlah warung (opsional, perlu levy)')}<input type="number" min={2} value={f.bonusNeeded} onChange={set('bonusNeeded')} placeholder={tr('none', 'tanpa')} /></label>
          <label>{tr('Bonus reward (sats)', 'Hadiah bonus (sats)')}<input type="number" min={1} value={f.bonusReward} onChange={set('bonusReward')} disabled={!f.bonusNeeded.trim()} /></label>
          <label className="wide">{tr('Wallet metadata URL (optional: where you will host bcmr.json, e.g. GitHub Pages)', 'URL metadata wallet (opsional: tempat kamu akan meng-host bcmr.json, mis. GitHub Pages)')}<input value={f.bcmrUrl} onChange={set('bcmrUrl')} placeholder="https://you.github.io/rally/bcmr.json" /></label>
        </div>
        <h2>{tr('Stalls', 'Warung')}</h2>
        {stalls.map((s, i) => (
          <div className="form stall-row" key={i}>
            <label>{tr('Name', 'Nama')}<input value={s.name} onChange={setStall(i, 'name')} placeholder={`Stall ${i + 1}`} maxLength={40} /></label>
            <label>Emoji<input value={s.emoji} onChange={setStall(i, 'emoji')} maxLength={4} /></label>
            <label>{tr('Price', 'Harga')}<input type="number" min={546} value={s.price} onChange={setStall(i, 'price')} /></label>
            <label>{tr('Member price', 'Harga member')}<input type="number" min={546} value={s.memberPrice} onChange={setStall(i, 'memberPrice')} /></label>
            <label className="wide">{tr("Stall's BCH address (empty = yours)", 'Alamat BCH warung (kosong = milikmu)')}<input value={s.address} onChange={setStall(i, 'address')} placeholder="bitcoincash:q…" /></label>
            <label className="wide">{tr("Proof of presence: the stall device's key from #/device (optional, needs a levy)", 'Bukti kehadiran: kunci perangkat warung dari #/device (opsional, perlu levy)')}<input value={s.presenceKey ?? ''} onChange={setStall(i, 'presenceKey')} placeholder="02…" /></label>
            <label className="wide">{tr('Location (address or lat,lng; optional, shown as a map link)', 'Lokasi (alamat atau lat,lng; opsional, tampil sebagai link peta)')}<input value={s.place ?? ''} onChange={setStall(i, 'place')} placeholder="Jl. Malioboro, Yogyakarta" maxLength={80} /></label>
          </div>
        ))}
        <p className="row">
          <button className="ghost" onClick={() => setStalls([...stalls, { name: '', emoji: '⭐', price: '5000', memberPrice: '4500', address: '' }])} disabled={stalls.length >= 12}>+ {tr('Add a stall', 'Tambah warung')}</button>
          {stalls.length > 1 && <button className="ghost" onClick={() => setStalls(stalls.slice(0, -1))}>− {tr('Remove the last', 'Hapus yang terakhir')}</button>}
        </p>
        {problem ? <p className="error" role="alert">{problem}</p>
          : <p className="hint">{tr(`Your wallet will lock about ${sats(need)} (prize pool, one coin per stall lane, fees).`, `Wallet-mu akan mengunci sekitar ${sats(need)} (pool hadiah, satu koin per jalur warung, fee).`)}
            {margin > 0 && tr(` Your fee: every set's levies exceed its reward by at least ${sats(margin)}; that surplus stays in the pool and comes back to you with reclaim after the rally ends.`,
              ` Fee-mu: levy tiap set melebihi hadiahnya minimal ${sats(margin)}; surplus itu tertahan di pool dan kembali kepadamu lewat reclaim setelah rally berakhir.`)}</p>}
        {lock
          ? <button className="primary big" disabled={!!problem || !!busy} onClick={open}>{busy ?? tr('Open the rally', 'Buka rally')}</button>
          : <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>}
        {err && <p className="error" role="alert">{err}</p>}
        <p className="muted small">{tr('Anti-farming (reward below the cheapest set at member price) and, with a levy, anti-collusion are checked before your wallet is asked. Reclaiming the leftover pool after the rally ends is done with the CLI for now.',
          'Anti-farming (hadiah di bawah set termurah dengan harga member) dan, bila ada levy, anti-kolusi dicek sebelum wallet diminta tanda tangan. Mengambil sisa pool setelah rally berakhir saat ini lewat CLI.')}</p>
      </>)}
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri}
          title={tr('Connect with WizardConnect', 'Hubungkan lewat WizardConnect')} subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />
      )}
      <p><a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}

// ---- #/reclaim: after a rally ends, its organizer takes back what is left of the pool. Signed locally with the rally's
// reclaim key (created on #/organize and kept in this browser, or pasted from the backup); no wallet prompt needed.
const reclaimStoreKey = (r: Rally) => `jelajah-reclaim-${r.category}`;
const MTP_LAG = 3600; // nodes check a time locktime against the median time past, about an hour behind the clock

function Reclaim() {
  const [wif, setWif] = useState(() => { try { return localStorage.getItem(reclaimStoreKey(rally)) ?? ''; } catch { return ''; } });
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = (() => { const d = decodePrivateKeyWif(wif.trim()); return typeof d === 'string' ? null : d.privateKey; })();
  const keyOk = !!key && binToHex(secp256k1.derivePublicKeyCompressed(key) as Uint8Array) === rally.organizerPub;
  const dest = (() => { const r = cashAddressToLockingBytecode(to.trim()); return typeof r === 'string' ? null : r.bytecode; })();
  const opensAt = rally.endTime + MTP_LAG;
  const open = LOADED_AT >= opensAt;
  async function reclaim() {
    setBusy(true); setErr(null);
    try {
      const { builder } = await buildReclaim({ rally, provider, vault, signer: new SignatureTemplate(key!), to: dest! });
      setDone((await builder.send()).txid);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <main className="organize">
      <p className="eyebrow">{rally.name} · {tr('for the organizer', 'untuk penyelenggara')}</p>
      <h1>{tr('Take back the leftover pool', 'Ambil kembali sisa pool')}</h1>
      <p className="lede">{tr(`The vault only lets its organizer take the pool back after the rally ends (${new Date(rally.endTime * 1000).toLocaleString()}). Until then every sat stays for the players.`,
        `Vault hanya mengizinkan penyelenggara mengambil pool setelah rally berakhir (${new Date(rally.endTime * 1000).toLocaleString('id-ID')}). Sampai saat itu setiap sat tetap untuk pemain.`)}</p>
      {done ? <p className="hint">✅ {tr('Reclaimed', 'Berhasil diambil')}: <a href={explorerTx(done)} target="_blank" rel="noreferrer">{done.slice(0, 16)}…</a></p> : (<>
        <div className="form">
          <label className="wide">{tr("This rally's reclaim key (saved in this browser when you opened it, or from your backup)", 'Kunci reclaim rally ini (tersimpan di browser saat kamu membukanya, atau dari backup)')}
            <input className="code" value={wif} onChange={(e) => setWif(e.target.value)} placeholder="K… / L… / c…" /></label>
          <label className="wide">{tr('Send the pool to (a BCH address; token-aware, it also receives the retired minting NFT)', 'Kirim pool ke (alamat BCH; yang mendukung token, karena minting NFT ikut dikirim)')}
            <input className="code" value={to} onChange={(e) => setTo(e.target.value)} placeholder={rally.network === 'mainnet' ? 'bitcoincash:z…' : 'bchtest:z…'} /></label>
        </div>
        {wif && !keyOk && <p className="error">{tr("That key doesn't belong to this rally's organizer.", 'Kunci itu bukan milik penyelenggara rally ini.')}</p>}
        {to && !dest && <p className="error">{tr('Not a valid address.', 'Alamat tidak valid.')}</p>}
        {!open && <p className="hint">{tr(`Opens at ${new Date(opensAt * 1000).toLocaleString()}.`, `Bisa dilakukan mulai ${new Date(opensAt * 1000).toLocaleString('id-ID')}.`)}</p>}
        <button className="primary big" disabled={!keyOk || !dest || !open || busy} onClick={reclaim}>{busy ? tr('Sending…', 'Mengirim…') : tr('Reclaim the pool', 'Ambil pool')}</button>
        {err && <p className="error" role="alert">{err}</p>}
      </>)}
      {keyOk && rally.minter === 3 && <AddStall keyBytes={key!} />}
      <p><a href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}

// Organizer tools: open a stall mid-rally (levy rallies). Signed locally with the reclaim (organizer) key; the fee comes from
// coins sent to that key's own address. The vault derives the new stall's minter itself (RewardVault2.addStall).
function AddStall({ keyBytes }: { keyBytes: Uint8Array }) {
  const keyLock = encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(keyBytes) as Uint8Array));
  const keyAddress = addressOf(keyLock);
  const [s, setS] = useState({ name: '', emoji: '⭐', price: '3000', memberPrice: '2700', address: '' });
  const [funds, setFunds] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ link: string; txid: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { provider.getUtxos(keyAddress).then((u) => setFunds(u.filter((x) => !x.token).reduce((t, x) => t + x.satoshis, 0n))).catch(() => {}); }, [keyAddress]);
  async function add() {
    setBusy(true); setErr(null);
    try {
      const signer = new SignatureTemplate(keyBytes);
      const coin = (await provider.getUtxos(keyAddress)).filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
      if (!coin) throw new Error(tr('Send a few thousand sats to the organizer address first', 'Kirim beberapa ribu sats ke alamat penyelenggara dulu'));
      let lock = binToHex(keyLock);
      if (s.address.trim()) { const r = cashAddressToLockingBytecode(s.address.trim()); if (typeof r === 'string') throw new Error(r); lock = binToHex(r.bytecode); }
      const { builder, rally: next } = await buildAddStall({ rally, provider, signer, changeTo: keyLock, feeCoin: { utxo: coin, unlocker: signer.unlockP2PKH() },
        stall: { name: s.name.trim() || 'New stall', emoji: s.emoji || '⭐', price: Number(s.price), memberPrice: Number(s.memberPrice || s.price), lock } });
      const { txid } = await builder.send();
      setMsg({ txid, link: await rallyLink(next as Rally) });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof s) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value });
  return (
    <section>
      <h2>{tr('Open a stall mid-rally', 'Buka warung baru di tengah rally')}</h2>
      <p className="muted small">{tr("The vault itself derives the new stall's minter from the stamp-minter code, so the minting NFT can only go to a real stall of this rally, with this rally's levy.",
        'Vault sendiri menurunkan minter warung baru dari kode stamp-minter, jadi minting NFT hanya bisa ke warung sungguhan rally ini, dengan levy rally ini.')}</p>
      {msg ? <p className="hint">✅ <a href={explorerTx(msg.txid)} target="_blank" rel="noreferrer">{msg.txid.slice(0, 16)}…</a> · {tr('New share link (with the new stall):', 'Share link baru (dengan warung baru):')} <a href={msg.link} style={{ wordBreak: 'break-all' }}>{msg.link.slice(0, 60)}…</a></p> : (<>
        <div className="form stall-row">
          <label>{tr('Name', 'Nama')}<input value={s.name} onChange={set('name')} maxLength={40} /></label>
          <label>Emoji<input value={s.emoji} onChange={set('emoji')} maxLength={4} /></label>
          <label>{tr('Price', 'Harga')}<input type="number" value={s.price} onChange={set('price')} /></label>
          <label>{tr('Member price', 'Harga member')}<input type="number" value={s.memberPrice} onChange={set('memberPrice')} /></label>
          <label className="wide">{tr("Stall's P2PKH address (empty = the organizer key)", 'Alamat P2PKH warung (kosong = kunci penyelenggara)')}<input value={s.address} onChange={set('address')} placeholder={rally.network === 'mainnet' ? 'bitcoincash:q…' : 'bchtest:q…'} /></label>
        </div>
        <p className="muted small">{tr('Fee coins (≥ 5,500 sats) at the organizer address:', 'Koin fee (≥ 5.500 sats) di alamat penyelenggara:')} <code className="wrap">{keyAddress}</code> · {funds === null ? '…' : sats(funds)}</p>
        <button className="primary" disabled={busy} onClick={add}>{busy ? tr('Sending…', 'Mengirim…') : tr('Open the stall', 'Buka warung')}</button>
        {err && <p className="error" role="alert">{err}</p>}
      </>)}
    </section>
  );
}

// ---- #/passport (?pp=…): trade a trophy from each of two rallies for the passport reward + a Passport NFT
function PassportPage() {
  const pp = passportFromLink!;
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  useEffect(() => { if (lock) walletCoins(wc.manager!).then(setCoins).catch(() => {}); }, [lock, wc.manager]);
  const pkh = lock ? hex(lock.slice(3, 23)) : '';
  const a = coins?.find((c) => isTrophyOf(pp.rallyA.category, pkh, c.utxo));
  const b = coins?.find((c) => isTrophyOf(pp.rallyB.category, pkh, c.utxo));
  async function claim() {
    setBusy(true); setErr(null);
    try {
      const fresh = await walletCoins(wc.manager!);
      const { builder, inputs } = await buildPassportClaim({ passport: pp, provider, ownerLock: lock!, coins: fresh.filter((c) => !c.utxo.token),
        trophyA: fresh.find((c) => isTrophyOf(pp.rallyA.category, pkh, c.utxo)), trophyB: fresh.find((c) => isTrophyOf(pp.rallyB.category, pkh, c.utxo)) });
      setDone(await signAndSend(wc.manager!, builder, inputs, tr(`Trade your two trophies for the ${pp.name} passport + ${sats(pp.reward)}`, `Tukar dua trofimu dengan paspor ${pp.name} + ${sats(pp.reward)}`)));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <main className="organize">
      <p className="eyebrow">{pp.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('passport', 'paspor')}</p>
      <h1>🛂 {pp.name}</h1>
      <p className="lede">{tr(`Finished both "${pp.rallyA.name}" and "${pp.rallyB.name}"? Trade one trophy from each for ${sats(pp.reward)} and a Passport NFT. The trophies are burned, so each pair counts once.`,
        `Sudah menyelesaikan "${pp.rallyA.name}" dan "${pp.rallyB.name}"? Tukar satu trofi dari masing-masing dengan ${sats(pp.reward)} dan NFT Paspor. Trofinya dibakar, jadi setiap pasangan hanya berlaku sekali.`)}</p>
      {done ? <p className="hint">✅ <a href={explorerTx(done)} target="_blank" rel="noreferrer">{done.slice(0, 16)}…</a></p>
        : !lock ? <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>
        : (<>
          <ul>
            <li>{a ? '🏆' : '·'} {pp.rallyA.name}</li>
            <li>{b ? '🏆' : '·'} {pp.rallyB.name}</li>
          </ul>
          <button className="primary big" disabled={!a || !b || busy} onClick={claim}>{busy ? tr('Approve in wallet…', 'Setujui di wallet…') : tr('Get my passport', 'Ambil pasporku')}</button>
        </>)}
      {err && <p className="error" role="alert">{err}</p>}
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />}
    </main>
  );
}

// ---- #/identity: Jelajah ID — link your BCH address and a Nostr key (each vouching for the other), find and verify
// anyone's link from public relays + the chain, see their Jelajah reputation, pay them, and log in by challenge.
type NostrSigner = { pubkey: string; sign: (t: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<NostrEvent> };
async function nostrSigner(): Promise<NostrSigner> {
  const ext = (window as unknown as { nostr?: { getPublicKey(): Promise<string>; signEvent(e: object): Promise<NostrEvent> } }).nostr;
  if (ext) return { pubkey: await ext.getPublicKey(), sign: (t) => ext.signEvent(t) }; // NIP-07 extension (Alby, nos2x…)
  let hexKey: string | null = null;
  try { hexKey = localStorage.getItem('jelajah-nostr-sk'); } catch { /* private mode */ }
  if (!hexKey) {
    hexKey = binToHex(generateSecretKey());
    try { localStorage.setItem('jelajah-nostr-sk', hexKey); } catch { /* this tab only */ }
  }
  const sk = hexToBin(hexKey);
  return { pubkey: getPublicKey(sk), sign: async (t) => finalizeEvent(t, sk) };
}

function IdentityPage() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  useEffect(() => { nostrSigner().then(setSigner).catch(() => {}); }, []);
  const address = lock ? addressOf(lock) : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ txid: string; relays: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ ok: boolean; address?: string; nostrPubkey?: string; txid?: string; reason?: string; stamps?: number; trophies?: number } | null>(null);
  const [login, setLogin] = useState<{ address?: string; note?: string } | null>(null);

  async function link() {
    setErr(null);
    try {
      setBusy(tr('Approve the proof in your wallet…', 'Setujui bukti di wallet…'));
      const coins = (await walletCoins(wc.manager!)).filter((c) => c.path[0] === 'receive' && c.path[1] === 0 && !c.utxo.token);
      const { builder, inputs } = buildProofTx({ provider, coins, address: address!, nostrPubkey: signer!.pubkey });
      const txid = await signAndSend(wc.manager!, builder, inputs, tr('Prove this address is yours for your Nostr key (Jelajah ID)', 'Buktikan alamat ini milikmu untuk kunci Nostr-mu (Jelajah ID)'), 0);
      setBusy(tr('Signing and publishing on Nostr…', 'Menandatangani dan menerbitkan di Nostr…'));
      const event = await signer!.sign(linkEvent({ address: address!, nostrPubkey: signer!.pubkey, txid, network: rally.network }));
      const pool = new SimplePool();
      const res = await Promise.allSettled(pool.publish(RELAYS, event));
      // also a standard NIP-39 claim, keeping the other claims in this key's list
      const [current] = (await pool.querySync(RELAYS, { kinds: [NIP39_KIND], authors: [signer!.pubkey] }, { maxWait: 4000 })).sort((a, b) => b.created_at - a.created_at);
      await Promise.allSettled(pool.publish(RELAYS, await signer!.sign(nip39Event(current, { address: address!, txid }))));
      pool.close(RELAYS);
      setLinked({ txid, relays: res.filter((r) => r.status === 'fulfilled').length });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function verify() {
    setErr(null); setFound(null); setBusy(tr('Searching public relays…', 'Mencari di relay publik…'));
    try {
      const q = query.trim();
      const pool = new SimplePool();
      const r = await findVerified(pool, q.includes(':') ? { address: q } : { nostrPubkey: q.startsWith('npub') ? (nip19.decode(q).data as string) : q }, provider);
      pool.close(RELAYS);
      if (r.ok) { // reputation that travels: this rally's stamps and trophies held by the verified address
        const held = (await provider.getUtxos(r.address!)).filter((u) => officialRallies.some((x) => isRallyNft(x, u)));
        setFound({ ...r, stamps: held.filter((u) => !u.token!.nft!.commitment.startsWith('00')).length, trophies: held.filter((u) => u.token!.nft!.commitment.startsWith('00')).length });
      } else setFound(r);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  async function doLogin() {
    setErr(null); setLogin(null);
    try {
      const challenge = loginChallenge(); // a real app would issue this and remember it
      const answer = await signer!.sign(loginEvent(challenge, location.origin));
      const problem = checkLogin(answer, challenge, location.origin);
      if (problem) throw new Error(problem);
      const pool = new SimplePool();
      const r = await findVerified(pool, { nostrPubkey: answer.pubkey }, provider);
      pool.close(RELAYS);
      setLogin(r?.ok ? { address: r.address! } : { note: tr('Signature OK, but no verified BCH link yet. Link first.', 'Tanda tangan OK, tapi belum ada tautan BCH terverifikasi. Tautkan dulu.') });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · Jelajah ID</p>
      <h1>{tr('One identity across Bitcoin Cash and Nostr', 'Satu identitas di Bitcoin Cash dan Nostr')}</h1>
      <p className="lede">{tr('Your wallet proves the BCH address by spending from it with your Nostr key in the OP_RETURN; your Nostr key signs a statement naming that address and proof. Anyone can find it on public relays and check both sides, without any server.',
        'Wallet-mu membuktikan alamat BCH dengan membelanjakan koin darinya, berisi kunci Nostr-mu di OP_RETURN; kunci Nostr-mu menandatangani pernyataan yang menyebut alamat dan bukti itu. Siapa pun bisa menemukannya di relay publik dan mengecek kedua sisi, tanpa server.')}</p>

      <h2>1 · {tr('Link yours', 'Tautkan milikmu')}</h2>
      <p className="muted small">Nostr: <code className="wrap">{signer ? nip19.npubEncode(signer.pubkey) : '…'}</code> {signer && !(window as unknown as { nostr?: unknown }).nostr && tr('(a key made in this browser; with a NIP-07 extension your own key is used)', '(kunci yang dibuat di browser ini; dengan ekstensi NIP-07 kuncimu sendiri yang dipakai)')}</p>
      {address ? <p className="muted small">BCH: <code className="wrap">{address}</code></p> : null}
      {linked ? <p className="hint">✅ {tr('Linked', 'Tertaut')}: <a href={explorerTx(linked.txid)} target="_blank" rel="noreferrer">{linked.txid.slice(0, 16)}…</a> · {tr(`published to ${linked.relays} relays`, `terbit di ${linked.relays} relay`)}</p>
        : address ? <button className="primary" disabled={!signer || !!busy} onClick={link}>{busy ?? tr('Link my BCH address and Nostr key', 'Tautkan alamat BCH dan kunci Nostr-ku')}</button>
        : <button className="primary" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>}
      <p className="muted small">{tr('The proof spends a coin at your first receive address (a few hundred sats of fee).', 'Bukti membelanjakan koin di alamat terima pertamamu (fee beberapa ratus sats).')}</p>

      <h2>2 · {tr('Find and verify anyone', 'Cari dan verifikasi siapa pun')}</h2>
      <div className="form"><label className="wide">{tr('npub, Nostr hex key, or BCH address', 'npub, kunci Nostr hex, atau alamat BCH')}<input className="code" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="npub1… / bitcoincash:q…" /></label></div>
      <button className="ghost" disabled={!query.trim() || !!busy} onClick={verify}>{tr('Verify', 'Verifikasi')}</button>
      {found && (found.ok
        ? <div className="claim ready"><div>
          <h3>✅ {tr('Verified', 'Terverifikasi')}</h3>
          <p className="small">{nip19.npubEncode(found.nostrPubkey!)} ⇄ <code className="wrap">{found.address}</code></p>
          <p className="muted small">{tr('BCH proof', 'Bukti BCH')} <a href={explorerTx(found.txid!)} target="_blank" rel="noreferrer">{found.txid!.slice(0, 16)}…</a> · {tr(`Jelajah (${officialRallies.length} rallies)`, `Jelajah (${officialRallies.length} rally)`)}: {found.stamps} stamp, {found.trophies} 🏆</p>
          <p className="small"><a href={`${found.address}?message=${encodeURIComponent('via Jelajah ID')}`}>{tr('Pay this identity in your wallet →', 'Bayar identitas ini di wallet-mu →')}</a></p>
        </div></div>
        : <p className="error">✗ {found.reason}</p>)}

      <h2>3 · {tr('Log in with it', 'Login dengannya')}</h2>
      <p className="muted small">{tr("An app hands out a challenge, your Nostr key signs it, and the app looks up your verified BCH address: no password, no account, no identity provider.", 'Aplikasi memberi challenge, kunci Nostr-mu menandatanganinya, lalu aplikasi mencari alamat BCH-mu yang terverifikasi: tanpa password, tanpa akun, tanpa penyedia identitas.')}</p>
      <button className="ghost" disabled={!signer} onClick={doLogin}>{tr('Log in with Jelajah ID', 'Login dengan Jelajah ID')}</button>
      {login && <p className="hint">{login.address ? `✅ ${tr('Logged in as', 'Masuk sebagai')} ${login.address}` : login.note}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />}
      <p><a href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}

// ---- #/solidcash: the StampCard ported to SolidCash, and its recorded runs (deploy -> fund -> 3 visits -> redeem).
const SOLIDCASH_RUNS = import.meta.glob('../solidcash/deployments/*.json', { eager: true, import: 'default' }) as Record<string, { network: string; address: string; stall: string; customer: string; txs: Record<string, string> }>;
function SolidCashPage() {
  const runs = Object.values(SOLIDCASH_RUNS).sort((a, b) => (a.network === 'mainnet' ? -1 : b.network === 'mainnet' ? 1 : 0));
  const link = (net: string, id: string) => (net === 'mainnet' ? `https://blockchair.com/bitcoin-cash/transaction/${id}` : `https://chipnet.imaginary.cash/tx/${id}`);
  return (
    <main className="organize">
      <p className="eyebrow">SolidCash · StampCard</p>
      <h1>{tr('A stall’s loyalty card, written in SolidCash', 'Kartu loyalitas warung, ditulis dengan SolidCash')}</h1>
      <p className="lede">{tr('Each paid visit stamps the customer’s card in a covenant-verified mapping; a full card redeems from the stall’s pot, signed by the customer’s own key. A full card always costs more than its reward, so the pot can’t be farmed.',
        'Setiap kunjungan berbayar menambah stamp di kartu pelanggan, di mapping yang diverifikasi covenant; kartu penuh dicairkan dari pot warung dengan tanda tangan kunci pelanggan sendiri. Kartu penuh selalu lebih mahal dari hadiahnya, jadi pot tidak bisa dikuras.')}</p>
      <p><a href="https://github.com/PugarHuda/jelajah/blob/main/solidcash/contracts/StampCard.scash" target="_blank" rel="noreferrer">StampCard.scash</a> · <a href="https://github.com/PugarHuda/jelajah/tree/main/solidcash" target="_blank" rel="noreferrer">{tr('tests and scripts', 'tes dan skrip')}</a></p>
      {runs.map((r) => (
        <section key={r.network}>
          <h2>{r.network}</h2>
          <p className="muted small">{tr('Contract', 'Kontrak')} <code className="wrap">{r.address}</code></p>
          <ol>{Object.entries(r.txs).map(([step, id]) => <li key={step}>{step}: <a href={link(r.network, id)} target="_blank" rel="noreferrer">{id.slice(0, 16)}…</a></li>)}</ol>
        </section>
      ))}
      <p><a href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}

type StatsData = {
  stalls: { id: number; stamps: number; buyers: number; revenue: bigint }[]; claims: number;
  collectors: { pkh: string; stalls: number; stamps: number; trophies: number }[];
};
const shortAddr = (pkh: string) => { const a = addressOf(hexToBin(`76a914${pkh}88ac`)); return `${a.slice(0, a.indexOf(':') + 7)}…${a.slice(-5)}`; };

// Every number here is recomputed from minter and vault history: no server, no database.
function Stats() {
  const [s, setS] = useState<StatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Jelajah ID: which collectors have a verified Nostr identity (looked up from public relays, verified on chain)
  const [ids, setIds] = useState<Record<string, string>>({});
  useEffect(() => { rallyStats({ rally, provider, minters, vault }).then(setS, (e) => setErr(String(e))); }, []);
  // all seasons: every official rally on this network is a season; trophies and stamps add up per collector (on demand:
  // it reads each rally's whole history)
  const [seasons, setSeasons] = useState<{ pkh: string; trophies: number; stamps: number; seasons: number }[] | 'loading' | null>(null);
  async function loadSeasons() {
    setSeasons('loading');
    try {
      const all = await Promise.all(officialRallies.map((r) => rallyStats({ rally: r, provider, ...rallyContracts(r, provider) })));
      const by = new Map<string, { pkh: string; trophies: number; stamps: number; seasons: number }>();
      all.forEach((st) => st.collectors.forEach((c: StatsData['collectors'][number]) => {
        const x = by.get(c.pkh) ?? { pkh: c.pkh, trophies: 0, stamps: 0, seasons: 0 };
        by.set(c.pkh, { ...x, trophies: x.trophies + c.trophies, stamps: x.stamps + c.stamps, seasons: x.seasons + 1 });
      }));
      setSeasons([...by.values()].sort((a, b) => b.trophies - a.trophies || b.seasons - a.seasons || b.stamps - a.stamps).slice(0, 10));
    } catch (e) { setErr(String(e)); setSeasons(null); }
  }
  useEffect(() => {
    if (!s?.collectors.length) return;
    const pool = new SimplePool();
    Promise.all(s.collectors.map(async (c) => {
      const r = await findVerified(pool, { address: addressOf(hexToBin(`76a914${c.pkh}88ac`)) }, provider).catch(() => null);
      return r?.ok ? [c.pkh, r.nostrPubkey!] as const : null;
    })).then((rows) => { pool.close(RELAYS); setIds(Object.fromEntries(rows.filter((r) => r !== null))); });
  }, [s]);
  const total = s?.stalls.reduce((a, x) => ({ stamps: a.stamps + x.stamps, revenue: a.revenue + x.revenue }), { stamps: 0, revenue: 0n });
  return (
    <main className="stats">
      <p className="eyebrow">{rally.name} · {rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'}</p>
      <h1>{tr('Stall dashboard', 'Dasbor warung')}</h1>
      <p className="lede">{tr("Every stamp is a paid visit. These numbers are read straight from each stall's covenant history: anyone can recompute them, and no one can inflate them.",
        'Setiap stamp adalah kunjungan yang dibayar. Angka ini dibaca langsung dari riwayat covenant tiap warung: siapa pun bisa menghitung ulang, dan tidak ada yang bisa menggelembungkannya.')}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {!s && !err && <p className="muted">{tr('Reading the chain…', 'Membaca chain…')}</p>}
      {s && total && (
        <table>
          <thead><tr><th>{tr('Stall', 'Warung')}</th><th>{tr('Stamps sold', 'Stamp terjual')}</th><th>{tr('Unique buyers', 'Pembeli unik')}</th><th>{tr('Paid to stall', 'Dibayar ke warung')}</th></tr></thead>
          <tbody>
            {rally.merchants.map((m) => {
              const x = s.stalls.find((y) => y.id === m.id)!;
              return <tr key={m.id}><td>{m.emoji} {m.name}</td><td>{x.stamps}</td><td>{x.buyers}</td><td>{sats(x.revenue)}</td></tr>;
            })}
          </tbody>
          <tfoot><tr><td>Total</td><td>{total.stamps}</td><td /><td>{sats(total.revenue)}</td></tr></tfoot>
        </table>
      )}
      {s && <p>{tr('Sets completed', 'Set selesai')}: <b>{s.claims}</b> {!rally.bonusNeeded && <> · {tr('rewards paid', 'hadiah dibayar')}: <b>{sats(BigInt(s.claims) * BigInt(rally.reward))}</b></>}</p>}
      {s && s.collectors.length > 0 && (<>
        <h2>{tr('Top collectors', 'Kolektor teratas')}</h2>
        <table>
          <thead><tr><th>{tr('Collector', 'Kolektor')}</th><th>{tr('Stalls visited', 'Warung dikunjungi')}</th><th>Stamp{ID ? '' : 's'}</th><th>{tr('Trophies', 'Trofi')}</th></tr></thead>
          <tbody>{s.collectors.map((c) => <tr key={c.pkh}><td><a href={`#/u/${addressOf(hexToBin(`76a914${c.pkh}88ac`))}`} onClick={() => setTimeout(() => location.reload())}><code>{shortAddr(c.pkh)}</code></a>{ids[c.pkh] && <> <a className="small" href={`https://njump.me/${nip19.npubEncode(ids[c.pkh])}`} target="_blank" rel="noreferrer" title={tr('Verified Jelajah ID: this address and this Nostr key prove each other', 'Jelajah ID terverifikasi: alamat ini dan kunci Nostr ini saling membuktikan')}>✓ Nostr</a></>}</td><td>{c.stalls}/{rally.merchants.length}</td><td>{c.stamps}</td><td>{'🏆'.repeat(Math.min(c.trophies, 5))}{c.trophies > 5 ? ` ×${c.trophies}` : ''}</td></tr>)}</tbody>
        </table>
      </>)}
      <h2>{tr('All seasons', 'Semua musim')}</h2>
      <p className="muted small">{tr(`Every official Jelajah rally on this network is a season (${officialRallies.length} so far). Their collectors, added up from each rally's history.`,
        `Setiap rally resmi Jelajah di network ini adalah satu musim (${officialRallies.length} sejauh ini). Kolektornya dijumlahkan dari riwayat tiap rally.`)}</p>
      {seasons === null && <button className="ghost" onClick={loadSeasons}>{tr('Load the all-season leaderboard', 'Muat papan peringkat semua musim')}</button>}
      {seasons === 'loading' && <p className="muted">{tr('Reading every season…', 'Membaca semua musim…')}</p>}
      {Array.isArray(seasons) && (seasons.length === 0 ? <p className="muted">{tr('No collectors yet.', 'Belum ada kolektor.')}</p> : (
        <table>
          <thead><tr><th>{tr('Collector', 'Kolektor')}</th><th>{tr('Seasons', 'Musim')}</th><th>Stamp{ID ? '' : 's'}</th><th>{tr('Trophies', 'Trofi')}</th></tr></thead>
          <tbody>{seasons.map((c) => <tr key={c.pkh}><td><a href={`#/u/${addressOf(hexToBin(`76a914${c.pkh}88ac`))}`} onClick={() => setTimeout(() => location.reload())}><code>{shortAddr(c.pkh)}</code></a></td><td>{c.seasons}</td><td>{c.stamps}</td><td>{c.trophies}</td></tr>)}</tbody>
        </table>
      ))}
      <a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}

// ---- proof of presence UI: QR codes, a camera scanner (native BarcodeDetector, paste fallback), the stall device page

// a stall's place opens in OpenStreetMap: coordinates as a pin, anything else as a search
const mapUrl = (place: string) => {
  const ll = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(place);
  return ll ? `https://www.openstreetmap.org/?mlat=${ll[1]}&mlon=${ll[2]}#map=18/${ll[1]}/${ll[2]}` : `https://www.openstreetmap.org/search?query=${encodeURIComponent(place)}`;
};

const qrImage = (text: string) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 8); };

/** Scan one QR with the camera. Only where the browser has BarcodeDetector; everyone can still paste the code. */
function ScanQR({ onCode }: { onCode: (code: string) => void }) {
  const [on, setOn] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!on || !video) return;
    let stop = false;
    let stream: MediaStream | undefined;
    const Detector = (window as unknown as { BarcodeDetector: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(async (s) => {
      stream = s;
      video.srcObject = s;
      await video.play();
      while (!stop) {
        const [code] = await detector.detect(video).catch(() => []);
        if (code) { onCode(code.rawValue.trim()); setOn(false); return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }).catch(() => setOn(false));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [on, video, onCode]);
  if (!('BarcodeDetector' in window)) return null;
  return on ? <video ref={setVideo} className="scan" muted playsInline /> : <button className="ghost" onClick={() => setOn(true)}>📷 {tr('Scan QR', 'Pindai QR')}</button>;
}

const validPresence = (m: Merchant, buyerPkh: string, lane: Utxo, sigHex: string) => /^[0-9a-f]{128}$/.test(sigHex)
  && secp256k1.verifySignatureSchnorr(hexToBin(sigHex), hexToBin(m.presenceKey!), sha256.hash(presenceMessage(rally, m.id, buyerPkh, lane)));

/** Shown when buying at a stall that wants proof of presence: show your code, get the stall's signature back. */
function PresencePanel({ m, lane, buyerPkh, onSig, onClose }: { m: Merchant; lane: Utxo; buyerPkh: string; onSig: (sig: string) => void; onClose: () => void }) {
  const [code, setCode] = useState('');
  const ok = validPresence(m, buyerPkh, lane, code);
  const mine = presenceCode(buyerPkh, lane);
  return (
    <section className="warn presence" role="dialog" aria-label={tr('Proof of presence', 'Bukti kehadiran')}>
      <b>{m.emoji} {m.name}: {tr('this stall checks that you are really here', 'warung ini memastikan kamu benar-benar datang')}</b>
      <ol>
        <li>{tr("Show this code to the stall's device:", 'Tunjukkan kode ini ke perangkat warung:')}<br /><img className="qr small" src={qrImage(mine)} alt={tr('Your buyer code', 'Kode pembelimu')} /><br /><code className="wrap small">{mine}</code></li>
        <li>{tr('Scan or paste the code it shows back:', 'Pindai atau tempel kode balasannya:')}<br />
          <ScanQR onCode={setCode} />
          <input className="code" value={code} onChange={(e) => setCode(e.target.value.trim().toLowerCase())} placeholder={tr("stall's code", 'kode warung')} /></li>
      </ol>
      {code && !ok && <p className="error">{tr("That code isn't this stall's signature for you.", 'Kode itu bukan tanda tangan warung ini untukmu.')}</p>}
      <p className="row">
        <button className="primary" disabled={!ok} onClick={() => onSig(code)}>{tr('Buy with the stall’s code', 'Beli dengan kode warung')}</button>
        <button className="ghost" onClick={onClose}>{tr('Cancel', 'Batal')}</button>
      </p>
    </section>
  );
}

/** #/device/<stall id>: the stall's phone. Holds the stall's presence key and signs each buyer's code. */
function Device() {
  const id = Number(location.hash.match(/^#\/device\/(\d+)/)?.[1] ?? 0);
  const m = rally.merchants.find((x) => x.id === id);
  const [key, setKey] = useState(() => {
    let k: string | null = null;
    try { k = localStorage.getItem('jelajah-device-key'); } catch { /* private mode */ }
    if (!k) {
      k = binToHex(generatePrivateKey());
      try { localStorage.setItem('jelajah-device-key', k); } catch { /* the key then lives only in this tab */ }
    }
    return k;
  });
  const pub = binToHex(secp256k1.derivePublicKeyCompressed(hexToBin(key)) as Uint8Array);
  const [buyer, setBuyer] = useState('');
  const parsed = parsePresenceCode(buyer);
  const sig = m && parsed ? binToHex(signPresence(hexToBin(key), rally, m.id, parsed.buyerPkh, parsed.outpoint)) : null;
  return (
    <main className="poster device">
      <p className="eyebrow">{rally.name} · {tr('stall device', 'perangkat warung')}</p>
      <h1>{m ? `${m.emoji} ${m.name}` : tr('Stall device', 'Perangkat warung')}</h1>
      <p className="muted small">{tr("This device's presence key (give it to the organizer when the rally is set up):", 'Kunci presence perangkat ini (berikan ke penyelenggara saat rally dibuat):')}<br /><code className="wrap">{pub}</code></p>
      <details className="muted small">
        <summary>{tr('Back up or move this key', 'Backup atau pindahkan kunci ini')}</summary>
        <p>{tr('Secret key (keep it private; paste it on a new phone to take over this stall):', 'Kunci rahasia (jangan dibagikan; tempel di ponsel baru untuk mengambil alih warung ini):')}<br /><code className="wrap">{key}</code></p>
        <label>{tr('Use another key (64 hex characters):', 'Pakai kunci lain (64 karakter hex):')}
          <input className="code" placeholder="…" onChange={(e) => {
            const k = e.target.value.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(k) && secp256k1.validatePrivateKey(hexToBin(k))) {
              try { localStorage.setItem('jelajah-device-key', k); } catch { /* this tab only */ }
              setKey(k);
            }
          }} /></label>
      </details>
      {m && m.presenceKey !== pub && <p className="error">{tr("This device's key is not the one registered for this stall, so its codes won't work here.", 'Kunci perangkat ini bukan yang terdaftar untuk warung ini, jadi kodenya tidak akan berlaku.')}</p>}
      {m && (<>
        <p className="lede">{tr("Scan or paste the buyer's code, then let them scan the reply.", 'Pindai atau tempel kode pembeli, lalu biarkan mereka memindai balasannya.')}</p>
        <ScanQR onCode={(c) => setBuyer(c.toLowerCase())} />
        <input className="code" value={buyer} onChange={(e) => setBuyer(e.target.value.trim().toLowerCase())} placeholder={tr("buyer's code", 'kode pembeli')} />
        {buyer && !parsed && <p className="error">{tr("That isn't a Jelajah buyer code.", 'Itu bukan kode pembeli Jelajah.')}</p>}
        {sig && <><img className="qr" src={qrImage(sig)} alt={tr('Signed code for the buyer', 'Kode bertanda tangan untuk pembeli')} /><code className="wrap small">{sig}</code></>}
      </>)}
      {m && <p className="small"><a href={`#/till/${m.id}`} onClick={() => setTimeout(() => location.reload())}>🔔 {tr('Open this stall’s till', 'Buka kasir warung ini')}</a></p>}
      <p className="muted small">{tr('The code works once, for this buyer, at this stall, in this rally: a screenshot is useless to anyone else, and to them after they buy.', 'Kode ini berlaku sekali, untuk pembeli ini, di warung ini, di rally ini: screenshot tidak berguna bagi orang lain, dan bagi mereka setelah membeli.')}</p>
    </main>
  );
}

// ---- #/story: "A day of roaming Jogja", the rally told in six panels (media piece, BCH BLAZE Media Track).
// The art is the real stamps and trophy of the live rally; every number comes from the rally record.
function Story() {
  const m = (id: number) => rally.merchants.find((x) => x.id === id) ?? rally.merchants[0];
  const [kopi, bakmi, sate, dawet] = [m(1), m(2), m(3), m(4)];
  const price = (x: Merchant, member = false) => sats(cost(x, member));
  const panels: { art: React.ReactNode; en: React.ReactNode; id: React.ReactNode; tag: string }[] = [
    {
      tag: '07:10',
      art: <div className="scene">🚉 <span>☕</span></div>,
      en: <>Rani steps off the train at Tugu with a phone, a Bitcoin Cash wallet and no plan. A poster on a warung by the station says <b>“{rally.name}: collect {rally.needed} stamps, get rewarded.”</b> No app to install. Just a QR.</>,
      id: <>Rani turun dari kereta di Tugu, bermodal ponsel, wallet Bitcoin Cash, dan tanpa rencana. Poster di warung dekat stasiun bertuliskan <b>“{rally.name}: kumpulkan {rally.needed} stamp, dapat hadiah.”</b> Tidak perlu pasang aplikasi. Cukup QR.</>,
    },
    {
      tag: '07:20',
      art: <Stamp m={kopi} inked size={150} />,
      en: <>{kopi.emoji} {kopi.name}. Rani pays {price(kopi)} and the stamp appears in the wallet <b>in the very same transaction</b>. The stall's covenant only lets a stamp out when the stall got paid. So the stamp isn't a promise of a visit. It is the visit.</>,
      id: <>{kopi.emoji} {kopi.name}. Rani membayar {price(kopi)} dan stamp muncul di wallet <b>di transaksi yang sama</b>. Covenant warung hanya mengeluarkan stamp kalau warung sudah dibayar. Jadi stamp bukan janji kunjungan. Stamp itu kunjungannya.</>,
    },
    {
      tag: '12:30',
      art: <div className="scene"><Stamp m={bakmi} inked size={120} /><span className="ring">🔔</span></div>,
      en: <>{bakmi.emoji} {bakmi.name} in Kotagede. Behind the wood fire, Pak Darto's old phone rings: the till heard the payment hit the network. He never has to check a screen to trust it.</>,
      id: <>{bakmi.emoji} {bakmi.name} di Kotagede. Di balik tungku, ponsel lama Pak Darto berbunyi: kasir mendengar pembayaran masuk ke jaringan. Dia tidak perlu memelototi layar untuk percaya.</>,
    },
    {
      tag: '19:00',
      art: <div className="scene stack"><Stamp m={kopi} inked size={90} /><Stamp m={bakmi} inked size={90} /><Stamp m={sate} inked size={90} /></div>,
      en: <>{sate.emoji} {sate.name}, satay on bicycle spokes. Three different stalls, three stamps, all bought by Rani's own key. Two stamps from the same stall wouldn't count, and neither would stamps bought from a friend.</>,
      id: <>{sate.emoji} {sate.name}, sate tusuk jeruji sepeda. Tiga warung berbeda, tiga stamp, semuanya dibeli kunci milik Rani sendiri. Dua stamp dari warung yang sama tidak dihitung, begitu juga stamp beli dari teman.</>,
    },
    {
      tag: '19:05',
      art: <Trophy name={rally.name} size={150} />,
      en: <>One tap: the three stamps burn, the rally vault checks them in a loop, pays Rani {sats(rally.reward)} and mints a trophy. The prize money was never in anyone's pocket{rally.levy ? <>, and because every stamp paid a levy into the pool, even stalls that collude can't drain it</> : null}.</>,
      id: <>Satu ketukan: tiga stamp dibakar, vault rally memeriksanya satu per satu, membayar Rani {sats(rally.reward)} dan mencetak trofi. Uang hadiah tidak pernah ada di kantong siapa pun{rally.levy ? <>, dan karena setiap stamp membayar levy ke pool, warung yang berkolusi pun tidak bisa mengurasnya</> : null}.</>,
    },
    {
      tag: tr('next day', 'besok'),
      art: <div className="scene"><Trophy name={rally.name} size={110} /><Stamp m={dawet} inked size={110} /></div>,
      en: <>{dawet.emoji} {dawet.name} at Beringharjo market. Rani shows the trophy: member price, {price(dawet, true)} instead of {price(dawet)}. The trophy comes straight back in the same transaction. It's a membership card nobody can fake or borrow.</>,
      id: <>{dawet.emoji} {dawet.name} di Pasar Beringharjo. Rani menunjukkan trofinya: harga member, {price(dawet, true)} bukan {price(dawet)}. Trofinya langsung kembali di transaksi yang sama. Kartu member yang tidak bisa dipalsukan atau dipinjam.</>,
    },
  ];
  return (
    <>
      <Banner />
      <main className="story">
        <p className="eyebrow">{rally.name} · {tr('a story in six panels', 'cerita dalam enam panel')}</p>
        <h1>{tr('A day of roaming Jogja', 'Sehari menjelajah Jogja')}</h1>
        <p className="lede">{tr('Jelajah means “to roam”. This is what a rally day looks like, on Bitcoin Cash mainnet.', 'Jelajah artinya menjelajah. Begini satu hari rally di mainnet Bitcoin Cash.')}</p>
        <ol className="panels">
          {panels.map((x, i) => (
            <li key={i} className="panel">
              <span className="panel-tag">{i + 1} · {x.tag}</span>
              <div className="panel-art" aria-hidden="true">{x.art}</div>
              <p>{ID ? x.id : x.en}</p>
            </li>
          ))}
        </ol>
        <div className="claim ready">
          <div>
            <h3>{tr('Your turn', 'Giliranmu')}</h3>
            <p className="muted small">{tr('Real stalls, real covenants, real sats. Connect Selene or Paytaca and buy your first stamp.', 'Warung nyata, covenant nyata, sats nyata. Hubungkan Selene atau Paytaca dan beli stamp pertamamu.')}</p>
          </div>
          <a className="primary big" href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('Start the rally →', 'Mulai rally →')}</a>
        </div>
        <p className="muted small">{tr('Rani and Pak Darto are made up; the stalls are real Jogja favourites and the rally is live.', 'Rani dan Pak Darto tokoh rekaan; warungnya favorit Jogja yang nyata dan rally-nya live.')} <button className="ghost lang" onClick={switchLang}>{ID ? 'EN' : 'ID'}</button></p>
      </main>
    </>
  );
}

const back = <p><a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>;

// ---- #/till/<stall id>: the stall's cashier screen. Rings on every paid stamp as soon as it hits the mempool,
// and keeps the totals, all read from the stall covenant's own history (no server, nothing to fake).
type Sale = { id: string; buyerPkh: string; paid: bigint; confirmed: boolean; fresh: boolean };
function Till() {
  const id = Number(location.hash.match(/^#\/till\/(\d+)/)?.[1] ?? 0);
  const m = rally.merchants.find((x) => x.id === id);
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bell, setBell] = useState<AudioContext | null>(null);
  const bellRef = useRef<AudioContext | null>(null);
  useEffect(() => { bellRef.current = bell; }, [bell]);
  useEffect(() => {
    if (!m) return;
    const seen = new Set<string>(), known = new Set<string>();
    let first = true, stop = false, timer = 0;
    const poll = async () => {
      try {
        const { ids, sales: got } = await stallSales({ rally, provider, minter: minters[m.id], merchantId: m.id, skip: seen });
        ids.forEach((x: string) => seen.add(x));
        const fresh = !first;
        const newcomers = got.filter((x: { id: string }) => !known.has(x.id)); // a pending sale comes back until it confirms
        newcomers.forEach((x: { id: string }) => known.add(x.id));
        setSales((s) => {
          const old = new Map((s ?? []).map((x) => [x.id, x]));
          const next: Sale[] = got.map((x: Omit<Sale, 'fresh'>) => ({ ...x, fresh: old.get(x.id)?.fresh ?? fresh }));
          const ids = new Set(next.map((x) => x.id));
          return [...next.reverse(), ...(s ?? []).filter((x) => !ids.has(x.id))];
        });
        if (fresh && newcomers.length) ring(bellRef.current);
        first = false;
        setErr(null);
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
      if (!stop) timer = window.setTimeout(poll, 5000);
    };
    poll();
    return () => { stop = true; clearTimeout(timer); };
  }, [m]);
  if (!m) return <main className="organize"><p className="error">{tr('No such stall', 'Warung tidak ada')}</p>{back}</main>;
  const total = (sales ?? []).reduce((s, x) => s + x.paid, 0n);
  const fresh = (sales ?? []).filter((x) => x.fresh);
  return (
    <main className="poster device">
      <p className="eyebrow">{rally.name} · {tr('till', 'kasir')}</p>
      <h1>{m.emoji} {m.name}</h1>
      {!bell && <button className="primary" onClick={() => { const c = new AudioContext(); ring(c); setBell(c); }}>🔔 {tr('Turn on the sale bell', 'Nyalakan bel penjualan')}</button>}
      <p className="lede">{sales === null ? tr('Reading the chain…', 'Membaca chain…')
        : tr(`${sales.length} stamps sold · ${sats(total)} paid to this stall`, `${sales.length} stamp terjual · ${sats(total)} dibayar ke warung ini`)}</p>
      {fresh.length > 0 && <p className="hint"><b>🔔 +{fresh.length} {tr('since this screen opened', 'sejak layar ini dibuka')} · {sats(fresh.reduce((s, x) => s + x.paid, 0n))}</b></p>}
      <ul>{(sales ?? []).slice(0, 20).map((x) => (
        <li key={x.id}>{x.fresh ? '🔔 ' : ''}{sats(x.paid)}{x.confirmed ? '' : ` · ⏳ ${tr('unconfirmed', 'belum terkonfirmasi')}`} · <a href={`#/u/${addressOf(hexToBin(`76a914${x.buyerPkh}88ac`))}`} onClick={() => setTimeout(() => location.reload())}>{shortAddr(x.buyerPkh)}</a> · <a href={explorerTx(x.id)} target="_blank" rel="noreferrer">{x.id.slice(0, 10)}…</a></li>
      ))}</ul>
      {err && <p className="error" role="alert">{err}</p>}
      <p className="muted small">{tr('Keep this open on the stall’s phone or tablet. It rings when a stamp payment reaches the network: the covenant already checked the price. It is final once confirmed (⏳ goes away, about 10 minutes); for a big order, wait for that.', 'Biarkan terbuka di ponsel atau tablet warung. Bel berbunyi saat pembayaran stamp masuk ke jaringan, dan harganya sudah dicek covenant. Pembayaran final setelah terkonfirmasi (tanda ⏳ hilang, sekitar 10 menit); untuk pesanan besar, tunggu itu.')}</p>
      {back}
    </main>
  );
}
function ring(ctx: AudioContext | null) {
  navigator.vibrate?.(200);
  if (!ctx) return;
  [0, 0.18].forEach((t, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = i ? 1320 : 880;
    g.gain.setValueAtTime(0.3, ctx.currentTime + t);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.5);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + t);
    o.stop(ctx.currentTime + t + 0.5);
  });
}

// ---- #/u/<BCH address or npub>: a collector's page. What they hold in this rally, read from the chain, and their
// verified Nostr identity (Jelajah ID) if they linked one. Shareable: nothing here is self-reported.
type ProfileData = { address: string; npub?: string; stamps: Record<number, number>; bought: number; trophies: number; bonus: number; record: { r: Rally; stamps: number; trophies: number }[] };
function Profile() {
  const q = decodeURIComponent(location.hash.slice('#/u/'.length)).trim();
  const [p, setP] = useState<ProfileData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const pool = new SimplePool();
    (async () => {
      let address: string;
      let npub: string | undefined;
      if (q.includes(':')) {
        const l = cashAddressToLockingBytecode(q);
        if (typeof l === 'string') throw new Error(tr('Not a BCH address or npub', 'Bukan alamat BCH atau npub'));
        address = addressOf(l.bytecode);
        const r = await findVerified(pool, { address }, provider).catch(() => null);
        if (r?.ok) npub = nip19.npubEncode(r.nostrPubkey!);
      } else {
        const pk = q.startsWith('npub') ? nip19.decode(q).data as string : q;
        const r = await findVerified(pool, { nostrPubkey: pk }, provider);
        if (!r.ok) throw new Error(r.reason ?? tr('No verified BCH address for this Nostr key', 'Belum ada alamat BCH terverifikasi untuk kunci Nostr ini'));
        address = r.address!;
        npub = nip19.npubEncode(pk);
      }
      const pkh = binToHex((cashAddressToLockingBytecode(address) as { bytecode: Uint8Array }).bytecode.slice(3, 23));
      const utxos = await provider.getUtxos(address);
      // reputation that spans rallies: what this address holds in every official Jelajah rally on this network
      const record = officialRallies.map((r) => {
        const c = utxos.filter((u) => isRallyNft(r, u)).map((u) => u.token!.nft!.commitment);
        return { r, stamps: c.filter((x) => !x.startsWith('00')).length, trophies: c.filter((x) => x.startsWith('00')).length };
      }).filter((x) => x.stamps + x.trophies > 0);
      const held = utxos.filter((u) => isRallyNft(rally, u)).map((u) => u.token!.nft!.commitment);
      const stamps: Record<number, number> = {};
      held.filter((c) => !c.startsWith('00')).forEach((c) => { const s = parseInt(c.slice(0, 2), 16); stamps[s] = (stamps[s] ?? 0) + 1; });
      const trophies = held.filter((c) => c.startsWith('00'));
      setP({ address, npub, record, stamps, bought: held.filter((c) => !c.startsWith('00') && c.slice(2, 42) === pkh).length, trophies: trophies.length, bonus: trophies.filter((c) => c.length > 42).length });
    })().catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => pool.close(RELAYS));
  }, [q]);
  return (
    <main className="organize">
      <p className="eyebrow">{rally.name} · {tr('collector', 'kolektor')}</p>
      <h1>{p?.npub ? `✓ ${p.npub.slice(0, 16)}…` : p ? `${p.address.slice(0, p.address.indexOf(':') + 9)}…` : tr('Collector', 'Kolektor')}</h1>
      {!p && !err && <p className="muted">{tr('Reading the chain and public relays…', 'Membaca chain dan relay publik…')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {p && (<>
        <p className="muted small"><code className="wrap">{p.address}</code>{p.npub && <> ⇄ <a href={`https://njump.me/${p.npub}`} target="_blank" rel="noreferrer">{tr('verified Nostr', 'Nostr terverifikasi')}</a></>}</p>
        <div className="trophies">
          {rally.merchants.map((m) => <div key={m.id} title={m.name}><Stamp m={m} inked={!!p.stamps[m.id]} size={96} />{p.stamps[m.id] > 1 && <b> ×{p.stamps[m.id]}</b>}</div>)}
        </div>
        <p>{tr(`${Object.keys(p.stamps).length}/${rally.merchants.length} stalls in hand · ${p.bought} stamps bought by this address · ${p.trophies} trophies`,
          `${Object.keys(p.stamps).length}/${rally.merchants.length} warung di tangan · ${p.bought} stamp dibeli alamat ini · ${p.trophies} trofi`)}{p.bonus > 0 && ` (${p.bonus} bonus)`}</p>
        {p.trophies > 0 && <div className="trophies">{Array.from({ length: Math.min(p.trophies, 6) }, (_, i) => <Trophy key={i} name={rally.name} bonus={i < p.bonus} size={96} />)}</div>}
        {p.record.length > 0 && (<>
          <h2>{tr('Across Jelajah rallies', 'Di semua rally Jelajah')}</h2>
          <ul>{p.record.map(({ r, stamps: n, trophies: t }) => <li key={r.category}>{r.name} {r.category === officialRallies[0]?.category ? tr('(live)', '(aktif)') : tr('(earlier)', '(sebelumnya)')} · <a href={explorerTx(r.genesisTx)} target="_blank" rel="noreferrer">{r.genesisTx.slice(0, 8)}…</a>: {n} stamp, {t} 🏆</li>)}</ul>
        </>)}
        <p className="muted small">{tr('Read from the chain just now. Stamps bought by this address are the ones it can claim a reward with; traded stamps are collectibles.', 'Dibaca dari chain barusan. Stamp yang dibeli alamat ini yang bisa diklaim hadiahnya; stamp hasil tukar hanya koleksi.')}</p>
        <p className="small">{tr('Share this page', 'Bagikan halaman ini')}: <code className="wrap">{location.href}</code></p>
      </>)}
      {back}
    </main>
  );
}

// ---- #/rallies: community rallies listed on Nostr by their organizers (from #/organize). Discovery without a server.
function Rallies() {
  const [list, setList] = useState<{ name: string; r: string; pubkey: string; created_at: number; onChain?: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const pool = new SimplePool();
    findRallies(pool, rally.network).then(async (found: { name: string; r: string; pubkey: string; created_at: number }[]) => {
      // a listing whose link doesn't parse is dropped; one whose genesis doesn't match the chain stays, unbadged
      const checked = await Promise.all(found.map(async (x) => {
        const r = await rallyFromPayload(x.r);
        return r && r.network === rally.network ? { ...x, onChain: await genesisMatches({ rally: r, provider }) } : null;
      }));
      setList(checked.filter((x) => x !== null));
    }, (e) => setErr(String(e))).finally(() => pool.close(RELAYS));
  }, []);
  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · Nostr</p>
      <h1>{tr('Community rallies', 'Rally komunitas')}</h1>
      <p className="lede">{tr('Rallies their organizers listed on public Nostr relays. Anyone can list one: check who runs it before you buy. Each rally is checked again when you open it.', 'Rally yang didaftarkan penyelenggaranya di relay Nostr publik. Siapa pun bisa mendaftarkan: cek siapa penyelenggaranya sebelum membeli. Setiap rally dicek ulang saat dibuka.')}</p>
      <h2>{tr('Official', 'Resmi')}</h2>
      <ul>{officialRallies.map((r, i) => <li key={r.category}>{i === 0
        ? <a href={location.pathname + (rally.network === 'chipnet' ? '?net=chipnet' : '')}>{r.name} · {tr('live', 'aktif')}</a>
        : <>{r.name} · {tr('earlier', 'sebelumnya')}</>} <span className="muted small">· <a href={explorerTx(r.genesisTx)} target="_blank" rel="noreferrer">{r.genesisTx.slice(0, 8)}…</a></span></li>)}</ul>
      <h2>{tr('Community', 'Komunitas')}</h2>
      {list === null && !err && <p className="muted">{tr('Asking the relays…', 'Bertanya ke relay…')}</p>}
      {list?.length === 0 && <p className="muted">{tr('None listed yet.', 'Belum ada.')} <a href="#/organize" onClick={() => setTimeout(() => location.reload())}>{tr('Open one →', 'Buka satu →')}</a></p>}
      <ul>{list?.map((x) => <li key={x.pubkey + x.r.slice(0, 24)}><a href={`${location.pathname}?r=${x.r}`}>{x.name || tr('(untitled)', '(tanpa nama)')}</a> {x.onChain ? <span className="small" title={tr('Its genesis on chain locks the prize vault this link describes', 'Genesis-nya di chain mengunci vault hadiah yang dijelaskan link ini')}>✓ {tr('on chain', 'di chain')}</span> : <span className="small error">✗ {tr('not found on chain', 'tidak ada di chain')}</span>} <span className="muted small">· {nip19.npubEncode(x.pubkey).slice(0, 14)}… · {new Date(x.created_at * 1000).toLocaleDateString(ID ? 'id-ID' : 'en-US')}</span></li>)}</ul>
      {err && <p className="error" role="alert">{err}</p>}
      {back}
    </main>
  );
}

// ---- #/gift/<wif>: a gift link holding a few sats, so someone with an empty wallet can buy their first stamp.
// The key lives only in the link's #fragment, which browsers never send to a server. Whoever opens it first can take it.
function Gift() {
  const [wif] = useState(() => {
    const w = location.hash.slice('#/gift/'.length);
    if (w) return w;
    const made = encodePrivateKeyWif(generatePrivateKey(), rally.network === 'mainnet' ? 'mainnet' : 'testnet');
    history.replaceState(null, '', `${location.pathname}${location.search}#/gift/${made}`); // a reload keeps the same key
    return made;
  });
  const key = decodePrivateKeyWif(wif);
  const giftLock = typeof key === 'string' ? null : encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key.privateKey) as Uint8Array));
  const address = giftLock ? addressOf(giftLock) : '';
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    const look = () => provider.getUtxos(address).then((u) => setBalance(u.filter((x) => !x.token).reduce((s, x) => s + x.satoshis, 0n))).catch(() => {});
    look();
    const t = setInterval(look, 6000);
    return () => clearInterval(t);
  }, [address]);
  async function take() {
    setErr(null);
    try {
      if (typeof key === 'string') throw new Error(key);
      const coins = (await provider.getUtxos(address)).filter((u) => !u.token);
      const total = coins.reduce((s, u) => s + u.satoshis, 0n);
      const fee = 200n + 150n * BigInt(coins.length);
      if (total - fee < 546n) throw new Error(tr('This gift is empty (or already taken).', 'Hadiah ini kosong (atau sudah diambil).'));
      const sig = new SignatureTemplate(key.privateKey);
      const tb = new TransactionBuilder({ provider });
      coins.forEach((u) => tb.addInput(u, sig.unlockP2PKH()));
      setDone((await tb.addOutput({ to: lock!, amount: total - fee }).send()).txid);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  if (!giftLock) return <main className="organize"><p className="error">{tr('This gift link is broken.', 'Link hadiah ini rusak.')}</p>{back}</main>;
  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('gift link', 'link hadiah')}</p>
      <h1>🎁 {balance ? sats(balance) : tr('A Jelajah gift', 'Hadiah Jelajah')}</h1>
      {done ? <p className="hint">✅ {tr('In your wallet', 'Sudah di wallet-mu')}: <a href={explorerTx(done)} target="_blank" rel="noreferrer">{done.slice(0, 16)}…</a>. <a href={location.pathname + location.search} onClick={() => setTimeout(() => location.reload())}>{tr('Now buy your first stamp →', 'Sekarang beli stamp pertamamu →')}</a></p>
        : balance ? (lock
          ? <button className="primary big" onClick={take}>{tr(`Take ${sats(balance)} into my wallet`, `Ambil ${sats(balance)} ke wallet-ku`)}</button>
          : <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet to take it', 'Hubungkan wallet untuk mengambilnya')}</button>)
        : <p className="muted">{balance === null ? tr('Checking…', 'Mengecek…') : tr('Empty: fund it below, or it was already taken.', 'Kosong: isi di bawah, atau sudah diambil.')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <details className="small" open={balance === 0n}>
        <summary>{tr('Make a gift', 'Buat hadiah')}</summary>
        <p>{tr('1. Send a few thousand sats to this address (enough for one stamp or more):', '1. Kirim beberapa ribu sats ke alamat ini (cukup untuk satu stamp atau lebih):')}</p>
        <img className="qr small" src={qrImage(address)} alt={address} /><br /><code className="wrap">{address}</code>
        <p>{tr('2. Share this page’s link. The link IS the money: whoever opens it first can take it, so send it privately.', '2. Bagikan link halaman ini. Link ini adalah uangnya: siapa pun yang membukanya lebih dulu bisa mengambilnya, jadi kirim secara pribadi.')}</p>
        <code className="wrap">{location.href}</code>
        <p className="muted">{tr('Changed your mind? Open the link yourself and take it back.', 'Berubah pikiran? Buka link-nya sendiri dan ambil kembali.')}</p>
      </details>
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />}
      {back}
    </main>
  );
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
