import { useCallback, useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import qrcode from 'qrcode-generator';
import { rally, provider, minters, vault, type Merchant } from './chain';
import { buildStamp, buildClaim, isRallyNft, rallyStats, mergeLevies } from './lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, addressOf, type Coin } from './wallet';
import { Stamp, Trophy } from './Stamp';
import { SLIDES_URL, REPO_URL, VOTE_ADDRESS } from './links';

const sats = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} sats`;

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
  if (import.meta.env.DEV) (window as unknown as { __wc: unknown }).__wc = wc; // debugging aid in dev only
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

  const buy = (m: Merchant) => run(`${m.emoji} ${tr('Stamped at', 'Dapat stamp di')} ${m.name}`, async () => {
    const fresh = await walletCoins(wc.manager!); // never build on a stale or not-yet-loaded coin list
    const myTrophy = (rally.minter ?? 1) >= 2 ? fresh.find((c) => isRallyNft(rally, c.utxo) && stallOf(c) === 0 && mine(c)) : undefined;
    const price = sats(cost(m, !!myTrophy));
    const { builder, inputs } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: lock!, coins: fresh, trophy: myTrophy });
    return signAndSend(wc.manager!, builder, inputs, myTrophy
      ? tr(`Show your trophy, pay ${m.name} the member price ${price} and get its stamp`, `Tunjukkan trofimu, bayar ${m.name} harga member ${price} dan dapat stamp-nya`)
      : tr(`Pay ${m.name} ${price} and get its Jelajah stamp`, `Bayar ${m.name} ${price} dan dapat stamp Jelajah-nya`));
  });

  const claim = () => run(tr('🏆 Set claimed: reward + trophy', '🏆 Set diklaim: hadiah + trofi'), async () => {
    const fresh = await walletCoins(wc.manager!);
    const hexPkh = hex(lock!.slice(3, 23));
    const vaultUtxo = (await mergeLevies({ rally, provider, vault })) ?? undefined; // unsigned, so no wallet prompt
    const { builder, inputs } = await buildClaim({
      rally, provider, vault, buyerLock: lock!, vaultUtxo,
      stamps: fresh.filter((c) => isRallyNft(rally, c.utxo) && stallOf(c) > 0 && c.utxo.token!.nft!.commitment.slice(2) === hexPkh),
      coins: fresh.filter((c) => !c.utxo.token),
    });
    return signAndSend(wc.manager!, builder, inputs, tr(`Burn ${rally.needed} stamps for ${sats(rally.reward)} + a trophy`, `Bakar ${rally.needed} stamp untuk ${sats(rally.reward)} + trofi`));
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
                {tr(`Burns one stamp from each of ${rally.needed} stalls → ${sats(rally.reward)} + a ${rally.name} Trophy NFT.`,
                  `Membakar satu stamp dari tiap ${rally.needed} warung → ${sats(rally.reward)} + NFT Trofi ${rally.name}.`)}
                {rewardsLeft !== null && tr(` ${Math.max(rewardsLeft, 0)} rewards left in the pool.`, ` Sisa ${Math.max(rewardsLeft, 0)} hadiah di pool.`)}
              </p>
            </div>
            <button className="primary big" disabled={!ready || !!busy} onClick={claim}>
              {busy?.startsWith('🏆') ? tr('Approve in wallet…', 'Setujui di wallet…') : tr(`Claim ${sats(rally.reward)} + trophy`, `Klaim ${sats(rally.reward)} + trofi`)}
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
  const url = `${location.origin}${location.pathname}#stall-${m.id}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return (
    <main className="poster" style={{ '--c': m.color } as React.CSSProperties}>
      <p className="eyebrow">{rally.name} · stamp rally</p>
      <Stamp m={m} inked size={180} />
      <h1>{m.name}</h1>
      <p className="lede">{tr(`Pay here with Bitcoin Cash and get the ${m.name} stamp. Collect ${rally.needed} → get paid back.`, `Bayar di sini pakai Bitcoin Cash dan dapat stamp ${m.name}. Kumpulkan ${rally.needed} → uangmu kembali.`)}</p>
      <img className="qr" src={qr.createDataURL(8, 16)} alt={tr(`QR code to ${m.name}'s stall in the rally`, `Kode QR ke warung ${m.name} di rally`)} />
      <p className="muted small">{url}</p>
      <a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}

type StatsData = { stalls: { id: number; stamps: number; buyers: number; revenue: bigint }[]; claims: number };

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
      {s && <p>{tr('Sets completed', 'Set selesai')}: <b>{s.claims}</b> · {tr('rewards paid', 'hadiah dibayar')}: <b>{sats(BigInt(s.claims) * BigInt(rally.reward))}</b></p>}
      <a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
