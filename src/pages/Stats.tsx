import { useEffect, useState } from 'react';
import { hexToBin } from '@bitauth/libauth';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, findVerified } from '../lib/identity.js';
import { rally, provider, minters, vault, officialRallies } from '../chain';
import { rallyContracts, rallyStats, stampDays, streakOf, todayWib } from '../lib/tx.js';
import { addressOf } from '../wallet';
import { sats, ID, tr, shortAddr } from '../shared';

type StatsData = {
  stalls: { id: number; stamps: number; buyers: number; revenue: bigint }[]; claims: number;
  collectors: { pkh: string; stalls: number; stamps: number; trophies: number }[];
};
// Every number here is recomputed from minter and vault history: no server, no database.
export function Stats() {
  const [s, setS] = useState<StatsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Jelajah ID: which collectors have a verified Nostr identity (looked up from public relays, verified on chain)
  const [ids, setIds] = useState<Record<string, string>>({});
  const [streaks, setStreaks] = useState<Record<string, number>>({}); // 🔥 consecutive days with a stamp, per collector
  useEffect(() => { rallyStats({ rally, provider, minters, vault }).then(setS, (e) => setErr(String(e))); }, []);
  // all seasons: every official rally on this network is a season; trophies and stamps add up per collector (on demand:
  // it reads each rally's whole history)
  const [seasons, setSeasons] = useState<{ pkh: string; trophies: number; stamps: number; seasons: number; streak?: number }[] | 'loading' | null>(null);
  async function loadSeasons() {
    setSeasons('loading');
    try {
      const all = await Promise.all(officialRallies.map((r) => rallyStats({ rally: r, provider, ...rallyContracts(r, provider) })));
      const by = new Map<string, { pkh: string; trophies: number; stamps: number; seasons: number }>();
      all.forEach((st) => st.collectors.forEach((c: StatsData['collectors'][number]) => {
        const x = by.get(c.pkh) ?? { pkh: c.pkh, trophies: 0, stamps: 0, seasons: 0 };
        by.set(c.pkh, { ...x, trophies: x.trophies + c.trophies, stamps: x.stamps + c.stamps, seasons: x.seasons + 1 });
      }));
      const top = [...by.values()].sort((a, b) => b.trophies - a.trophies || b.seasons - a.seasons || b.stamps - a.stamps).slice(0, 10);
      const today = todayWib(); // 🔥 across seasons: a stamp in any official rally keeps the streak alive
      setSeasons(await Promise.all(top.map(async (c) => ({ ...c, streak: streakOf(await stampDays({ rally, rallies: officialRallies, provider, address: addressOf(hexToBin(`76a914${c.pkh}88ac`)), pkh: c.pkh }).catch(() => []), today) }))));
    } catch (e) { setErr(String(e)); setSeasons(null); }
  }
  useEffect(() => {
    if (!s?.collectors.length) return;
    const pool = new SimplePool();
    Promise.all(s.collectors.map(async (c) => {
      const r = await findVerified(pool, { address: addressOf(hexToBin(`76a914${c.pkh}88ac`)) }, provider).catch(() => null);
      return r?.ok ? [c.pkh, r.nostrPubkey!] as const : null;
    })).then((rows) => { pool.close(RELAYS); setIds(Object.fromEntries(rows.filter((r) => r !== null))); });
    const today = todayWib();
    Promise.all(s.collectors.map(async (c) => [c.pkh, streakOf(await stampDays({ rally, provider, address: addressOf(hexToBin(`76a914${c.pkh}88ac`)), pkh: c.pkh }).catch(() => []), today)] as const))
      .then((rows) => setStreaks(Object.fromEntries(rows)));
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
          <thead><tr><th>{tr('Collector', 'Kolektor')}</th><th>{tr('Stalls visited', 'Warung dikunjungi')}</th><th>Stamp{ID ? '' : 's'}</th><th>{tr('Trophies', 'Trofi')}</th><th title={tr('Consecutive days with a stamp, from block times (Jogja time)', 'Hari berturut-turut dengan stamp, dari waktu blok (waktu Jogja)')}>🔥</th></tr></thead>
          <tbody>{s.collectors.map((c) => <tr key={c.pkh}><td><a href={`#/u/${addressOf(hexToBin(`76a914${c.pkh}88ac`))}`}><code>{shortAddr(c.pkh)}</code></a>{ids[c.pkh] && <> <a className="small" href={`https://njump.me/${nip19.npubEncode(ids[c.pkh])}`} target="_blank" rel="noreferrer" title={tr('Verified Jelajah ID: this address and this Nostr key prove each other', 'Jelajah ID terverifikasi: alamat ini dan kunci Nostr ini saling membuktikan')}>✓ Nostr</a></>}</td><td>{c.stalls}/{rally.merchants.length}</td><td>{c.stamps}</td><td>{'🏆'.repeat(Math.min(c.trophies, 5))}{c.trophies > 5 ? ` ×${c.trophies}` : ''}</td><td>{streaks[c.pkh] ? `${streaks[c.pkh]}` : ''}</td></tr>)}</tbody>
        </table>
      </>)}
      <h2>{tr('All seasons', 'Semua musim')}</h2>
      <p className="muted small">{tr(`Every official Jelajah rally on this network is a season (${officialRallies.length} so far). Their collectors, added up from each rally's history.`,
        `Setiap rally resmi Jelajah di network ini adalah satu musim (${officialRallies.length} sejauh ini). Kolektornya dijumlahkan dari riwayat tiap rally.`)}</p>
      {seasons === null && <button className="ghost" onClick={loadSeasons}>{tr('Load the all-season leaderboard', 'Muat papan peringkat semua musim')}</button>}
      {seasons === 'loading' && <p className="muted">{tr('Reading every season…', 'Membaca semua musim…')}</p>}
      {Array.isArray(seasons) && (seasons.length === 0 ? <p className="muted">{tr('No collectors yet.', 'Belum ada kolektor.')}</p> : (
        <table>
          <thead><tr><th>{tr('Collector', 'Kolektor')}</th><th>{tr('Seasons', 'Musim')}</th><th>Stamp{ID ? '' : 's'}</th><th>{tr('Trophies', 'Trofi')}</th><th title={tr('Consecutive days with a stamp in any season', 'Hari berturut-turut dengan stamp di musim mana pun')}>🔥</th></tr></thead>
          <tbody>{seasons.map((c) => <tr key={c.pkh}><td><a href={`#/u/${addressOf(hexToBin(`76a914${c.pkh}88ac`))}`}><code>{shortAddr(c.pkh)}</code></a></td><td>{c.seasons}</td><td>{c.stamps}</td><td>{c.trophies}</td><td>{c.streak || ''}</td></tr>)}</tbody>
        </table>
      ))}
      <a href="#">{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}

// ---- proof of presence UI: QR codes, a camera scanner (native BarcodeDetector, paste fallback), the stall device page
