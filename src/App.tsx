import { useCallback, useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import qrcode from 'qrcode-generator';
import { hexToBin, binToHex, cashAddressToLockingBytecode, secp256k1, sha256, generatePrivateKey, encodePrivateKeyWif, decodePrivateKeyWif } from '@bitauth/libauth';
import { TransactionBuilder, SignatureTemplate, type Utxo } from 'cashscript';
import { rally, provider, minters, vault, rallyLink, fromLink, type Merchant, type Rally } from './chain';
import { buildStamp, buildClaim, isRallyNft, rallyStats, mergeLevies, checkRallyConfig, genesisNeed, planRally, buildGenesis, presenceMessage, signPresence, presenceCode, parsePresenceCode, pickLane, buildReclaim } from './lib/tx.js';
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
const cost = (m: Merchant, member: boolean) => (member ? m.memberPrice! : m.price) + (rally.levy ?? 0);
const stallOf = (c: Coin) => parseInt(c.utxo.token!.nft!.commitment.slice(0, 2), 16);

export default function App() {
  const stallFromHash = window.location.hash.match(/^#\/stall\/(\d+)/)?.[1];
  if (stallFromHash) return <StallPoster m={rally.merchants.find((x) => x.id === Number(stallFromHash))} />;
  if (window.location.hash === '#/stats') return <Stats />;
  if (window.location.hash === '#/organize') return <Organize />;
  if (window.location.hash.startsWith('#/device')) return <Device />;
  if (window.location.hash === '#/reclaim') return <Reclaim />;
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
  const mine = (c: Coin) => lock && c.utxo.token!.nft!.commitment.slice(2) === hex(lock.slice(3, 23));
  const stamps = nfts.filter((c) => stallOf(c) > 0 && mine(c));
  const trophies = nfts.filter((c) => stallOf(c) === 0);
  const member = (rally.minter ?? 1) >= 2 && trophies.some(mine); // own trophy -> member price at every stall
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
    const price = sats(cost(m, !!myTrophy));
    const { builder, inputs } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: lock!, coins: fresh, trophy: myTrophy, presence: presence ? hexToBin(presence) : undefined, lane });
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
        <a className="brand" href="#"><span className="brand-mark">◉</span> Jelajah</a>
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
            ? <h1>Jajan di {rally.needed} warung.<br />Kumpulkan {rally.needed} stamp.<br /><em>Uangmu kembali.</em></h1>
            : <h1>Eat at {rally.needed} stalls.<br />Collect {rally.needed} stamps.<br /><em>Get paid back.</em></h1>}
          {ID ? (
            <p className="lede">
              Bayar di warung dan stamp NFT-nya tercetak <b>di transaksi yang sama</b>. Bakar satu set lengkap, kontrak rally
              membayarmu {sats(rally.reward)} dan mencetak trofimu. Tanpa daftar, tanpa server, tanpa ada yang memegang uang hadiah.
            </p>
          ) : (
            <p className="lede">
              Paying a stall prints its stamp NFT <b>in the same transaction</b>. Burn a full set and the rally's
              contract pays you {sats(rally.reward)} and mints your trophy. No sign-up, no server, no one holding the prize money.
            </p>
          )}
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
                      : `${have ? tr('Again', 'Lagi') : tr('Buy', 'Beli')} · ${sats(cost(m, member))}${member ? ' ★' : ''}`}
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
            <div className="trophies">{trophies.map((t) => <Trophy key={t.utxo.txid} name={rally.name} />)}</div>
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
            <dt>{tr('Organizers', 'Penyelenggara')}</dt><dd><a href="#/organize" onClick={() => setTimeout(() => location.reload())}>{tr('Open your own rally →', 'Buka rally-mu sendiri →')}</a> · <a href="#/reclaim" onClick={() => setTimeout(() => location.reload())}>{tr('reclaim after the end', 'ambil sisa pool')}</a></dd>
            <dt>{tr('Stall posters', 'Poster warung')}</dt><dd>{rally.merchants.map((m) => <a key={m.id} href={`#/stall/${m.id}`}>{m.emoji} {m.name}</a>)}</dd>
          </dl>
        </section>
      </main>
      <footer>Jelajah · {tr('stamp rallies on Bitcoin Cash · built for BCH BLAZE 2026', 'stamp rally di Bitcoin Cash · dibuat untuk BCH BLAZE 2026')} {lock && <span className="muted">· {tr('your stamp address', 'alamat stamp-mu')} {addressOf(lock, true)}</span>}</footer>
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
      <p className="lede">{tr(`Pay here with Bitcoin Cash and get the ${m.name} stamp. Collect ${rally.needed} → get paid back.`, `Bayar di sini pakai Bitcoin Cash dan dapat stamp ${m.name}. Kumpulkan ${rally.needed} → uangmu kembali.`)}</p>
      <img className="qr" src={qr.createDataURL(8, 16)} alt={tr(`QR code to ${m.name}'s stall in the rally`, `Kode QR ke warung ${m.name} di rally`)} />
      <p className="muted small">{url}</p>
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
  const [f, setF] = useState({ name: '', needed: '3', reward: '4000', rewardsInPool: '2', durationDays: '30', levy: '', bonusNeeded: '', bonusReward: '' });
  const [stalls, setStalls] = useState<StallRow[]>([
    { name: '', emoji: '🍜', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '☕', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '🍢', price: '5000', memberPrice: '4500', address: '' },
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [reclaimWif, setReclaimWif] = useState<string | null>(null);

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
      const { builder } = buildGenesis({ provider, rally: r, rewardsInPool: c.rewardsInPool, base, organizerLock: lock! });
      const prize = sats(BigInt(r.reward) * BigInt(c.rewardsInPool));
      setBusy(tr('Approve the rally in your wallet…', 'Setujui pembukaan rally di wallet…'));
      const txid = await signAndSend(m, builder, [base], tr(`Open the rally "${r.name}" and lock ${prize} of prizes`, `Buka rally "${r.name}" dan kunci hadiah ${prize}`), 0);
      const wif = encodePrivateKeyWif(reclaimKey, rally.network === 'mainnet' ? 'mainnet' : 'testnet');
      try { localStorage.setItem(reclaimStoreKey(r as Rally), wif); } catch { /* shown below for backup anyway */ }
      setReclaimWif(wif);
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
          : <p className="hint">{tr(`Your wallet will lock about ${sats(need)} (prize pool, one coin per stall lane, fees).`, `Wallet-mu akan mengunci sekitar ${sats(need)} (pool hadiah, satu koin per jalur warung, fee).`)}</p>}
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
  useEffect(() => { rallyStats({ rally, provider, minters, vault }).then(setS, (e) => setErr(String(e))); }, []);
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
          <tbody>{s.collectors.map((c) => <tr key={c.pkh}><td><code>{shortAddr(c.pkh)}</code></td><td>{c.stalls}/{rally.merchants.length}</td><td>{c.stamps}</td><td>{'🏆'.repeat(Math.min(c.trophies, 5))}{c.trophies > 5 ? ` ×${c.trophies}` : ''}</td></tr>)}</tbody>
        </table>
      </>)}
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
      <p className="muted small">{tr('The code works once, for this buyer, at this stall, in this rally: a screenshot is useless to anyone else, and to them after they buy.', 'Kode ini berlaku sekali, untuk pembeli ini, di warung ini, di rally ini: screenshot tidak berguna bagi orang lain, dan bagi mereka setelah membeli.')}</p>
    </main>
  );
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
