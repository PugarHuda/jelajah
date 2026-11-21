import { useEffect, useState } from 'react';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, findRallies } from '../lib/identity.js';
import { rally, provider, officialRallies, rallyFromPayload } from '../chain';
import { genesisMatches } from '../lib/tx.js';
import { explorerTx } from '../wallet';
import { ID, tr, back } from '../shared';

// ---- #/rallies: community rallies listed on Nostr by their organizers (from #/organize). Discovery without a server.
export function Rallies() {
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
