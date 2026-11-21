import { useCallback, useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { hexToBin, secp256k1, sha256 } from '@bitauth/libauth';
import { type Utxo } from 'cashscript';
import { rally, provider, minters, vault, fromLink, passportFromLink, officialRallies, type Merchant, type Rally } from './chain';
import { rallyContracts, isVoucher, buildStamp, buildClaim, buildStreak, isRallyNft, rallyStats, mergeLevies, presenceMessage, presenceCode, pickLane } from './lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, addressOf, type Coin } from './wallet';
import { Stamp, Trophy } from './Stamp';
import { StallPoster } from './pages/StallPoster';
import { Organize } from './pages/Organize';
import { Reclaim } from './pages/Reclaim';
import { PassportPage } from './pages/Passport';
import { IdentityPage } from './pages/Identity';
import { SolidCashPage } from './pages/SolidCash';
import { Stats } from './pages/Stats';
import { Device, ScanQR } from './pages/Device';
import { Story, Banner } from './pages/Story';
import { Till } from './pages/Till';
import { Profile } from './pages/Profile';
import { Rallies } from './pages/Rallies';
import { Gift } from './pages/Gift';
import { LOADED_AT, sats, idrPerBch, idrRate, rupiah, ID, tr, switchLang, cost, stallOf, mapUrl, shareUrl, shareTx, qrImage, hex } from './shared';

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
  // social proof, from the chain: stamps paid and sets claimed across every official rally on this network
  const [proof, setProof] = useState<{ stamps: number; sets: number } | null>(null);
  useEffect(() => {
    if (fromLink) return; // a community rally shows its own numbers on #/stats
    Promise.all(officialRallies.map((r) => rallyStats({ rally: r, provider, ...rallyContracts(r, provider) })))
      .then((all) => setProof({ stamps: all.reduce((n, x) => n + x.stalls.reduce((m: number, y: { stamps: number }) => m + y.stamps, 0), 0), sets: all.reduce((n, x) => n + x.claims, 0) }))
      .catch(() => {});
  }, []);
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
    // unsigned, so no wallet prompt; if it fails (e.g. a racing merge) the claim still uses the current vault coin
    const vaultUtxo = (await mergeLevies({ rally, provider, vault }).catch(() => null)) ?? undefined;
    const { builder, inputs } = await buildClaim({
      rally, provider, vault, buyerLock: lock!, vaultUtxo,
      stamps: fresh.filter((c) => isRallyNft(rally, c.utxo) && stallOf(c) > 0 && mine(c)),
      coins: fresh.filter((c) => !c.utxo.token), bonus,
    });
    return signAndSend(wc.manager!, builder, inputs, tr(`Burn ${burn} stamps for ${sats(prize)} + a trophy`, `Bakar ${burn} stamp untuk ${sats(prize)} + trofi`));
  });

  // streak rallies (minter 4): dated stamps from `streakDays` days in a row -> the streak reward + a streak trophy
  const streak = () => run(tr('🔥 Streak claimed', '🔥 Streak diklaim'), async () => {
    const fresh = await walletCoins(wc.manager!);
    const vaultUtxo = (await mergeLevies({ rally, provider, vault }).catch(() => null)) ?? undefined;
    const { builder, inputs } = await buildStreak({
      rally, provider, vault, buyerLock: lock!, vaultUtxo,
      stamps: fresh.filter((c) => isRallyNft(rally, c.utxo) && stallOf(c) > 0 && mine(c)),
      coins: fresh.filter((c) => !c.utxo.token),
    });
    return signAndSend(wc.manager!, builder, inputs, tr(`Burn ${rally.streakDays} stamps from ${rally.streakDays} days in a row for ${sats(rally.streakReward!)}`, `Bakar ${rally.streakDays} stamp dari ${rally.streakDays} hari berturut-turut untuk ${sats(rally.streakReward!)}`));
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
          {proof && proof.stamps > 0 && <p className="proof"><a href="#/stats" onClick={() => setTimeout(() => location.reload())}>{tr(`${proof.stamps} paid stamps · ${proof.sets} sets claimed on ${rally.network}, read from the chain`, `${proof.stamps} stamp terbayar · ${proof.sets} set diklaim di ${rally.network}, dibaca dari chain`)}</a></p>}
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
            {rally.minter === 4 && (
              <button className="big" disabled={!connected || !!busy} onClick={streak} title={tr('Stamps bought on consecutive days (UTC), any stalls', 'Stamp yang dibeli di hari berturut-turut (UTC), warung mana saja')}>
                {busy?.startsWith('🔥') ? tr('Approve in wallet…', 'Setujui di wallet…') : tr(`🔥 ${rally.streakDays}-day streak: ${sats(rally.streakReward!)}`, `🔥 Streak ${rally.streakDays} hari: ${sats(rally.streakReward!)}`)}
              </button>
            )}
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
            <ul>{log.map((l) => <li key={l.txid}>{l.label} · <a href={explorerTx(l.txid)} target="_blank" rel="noreferrer">{l.txid.slice(0, 12)}…</a> · <a href={shareUrl(l.label, l.txid)} onClick={shareTx(l.label, l.txid)} target="_blank" rel="noreferrer">{tr('Share', 'Bagikan')} ↗</a></li>)}</ul>
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
