import { useEffect, useRef, useState } from 'react';
import { hexToBin } from '@bitauth/libauth';
import { rally, provider, minters } from '../chain';
import { stallSales } from '../lib/tx.js';
import { explorerTx, addressOf } from '../wallet';
import { sats, tr, shortAddr, back } from '../shared';

// ---- #/till/<stall id>: the stall's cashier screen. Rings on every paid stamp as soon as it hits the mempool,
// and keeps the totals, all read from the stall covenant's own history (no server, nothing to fake).
type Sale = { id: string; buyerPkh: string; paid: bigint; confirmed: boolean; fresh: boolean };
export function Till() {
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
      {!!sales?.length && <p className="row"><button onClick={() => downloadCsv(`${m.name}-sales.csv`, sales)}>⬇ {tr('Download sales (CSV)', 'Unduh penjualan (CSV)')}</button></p>}
      <p className="muted small">{tr('Keep this open on the stall’s phone or tablet. It rings when a stamp payment reaches the network: the covenant already checked the price. It is final once confirmed (⏳ goes away, about 10 minutes); for a big order, wait for that.', 'Biarkan terbuka di ponsel atau tablet warung. Bel berbunyi saat pembayaran stamp masuk ke jaringan, dan harganya sudah dicek covenant. Pembayaran final setelah terkonfirmasi (tanda ⏳ hilang, sekitar 10 menit); untuk pesanan besar, tunggu itu.')}</p>
      {back}
    </main>
  );
}
function downloadCsv(name: string, sales: Sale[]) {
  const rows = [['txid', 'buyer', 'paid_sats', 'confirmed'], ...sales.map((x) => [x.id, addressOf(hexToBin(`76a914${x.buyerPkh}88ac`)), String(x.paid), String(x.confirmed)])];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
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
