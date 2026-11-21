import { tr } from '../shared';

// ---- #/solidcash: the StampCard ported to SolidCash, and its recorded runs (deploy -> fund -> 3 visits -> redeem).
const SOLIDCASH_RUNS = import.meta.glob('../../solidcash/deployments/*.json', { eager: true, import: 'default' }) as Record<string, { network: string; address: string; stall: string; customer: string; txs: Record<string, string> }>;
export function SolidCashPage() {
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
