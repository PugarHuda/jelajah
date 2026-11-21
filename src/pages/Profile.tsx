import { useEffect, useState } from 'react';
import { binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, findVerified } from '../lib/identity.js';
import { rally, provider, officialRallies, type Rally } from '../chain';
import { isRallyNft, stampDays, streakOf, todayWib } from '../lib/tx.js';
import { explorerTx, addressOf } from '../wallet';
import { Stamp, Trophy } from '../Stamp';
import { tr, back } from '../shared';

// ---- #/u/<BCH address or npub>: a collector's page. What they hold in this rally, read from the chain, and their
// verified Nostr identity (Jelajah ID) if they linked one. Shareable: nothing here is self-reported.
type ProfileData = { address: string; npub?: string; stamps: Record<number, number>; bought: number; trophies: number; bonus: number; record: { r: Rally; stamps: number; trophies: number }[]; streak: number | null; days: number };
export function Profile() {
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
      const [utxos, stampedDays] = await Promise.all([provider.getUtxos(address), stampDays({ rally, provider, address, pkh }).catch(() => null)]);
      // reputation that spans rallies: what this address holds in every official Jelajah rally on this network
      const record = officialRallies.map((r) => {
        const c = utxos.filter((u) => isRallyNft(r, u)).map((u) => u.token!.nft!.commitment);
        return { r, stamps: c.filter((x) => !x.startsWith('00')).length, trophies: c.filter((x) => x.startsWith('00')).length };
      }).filter((x) => x.stamps + x.trophies > 0);
      const held = utxos.filter((u) => isRallyNft(rally, u)).map((u) => u.token!.nft!.commitment);
      const stamps: Record<number, number> = {};
      held.filter((c) => !c.startsWith('00')).forEach((c) => { const s = parseInt(c.slice(0, 2), 16); stamps[s] = (stamps[s] ?? 0) + 1; });
      const trophies = held.filter((c) => c.startsWith('00'));
      setP({ address, npub, record, stamps, bought: held.filter((c) => !c.startsWith('00') && c.slice(2, 42) === pkh).length, trophies: trophies.length, bonus: trophies.filter((c) => c.length > 42).length, streak: stampedDays && streakOf(stampedDays, todayWib()), days: stampedDays?.length ?? 0 });
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
        {!!p.streak && <p><b>🔥 {tr(`${p.streak}-day streak`, `Streak ${p.streak} hari`)}</b> · {tr(`stamps bought on ${p.days} different days (Jogja time, from block times)`, `beli stamp di ${p.days} hari berbeda (waktu Jogja, dari waktu blok)`)}</p>}
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
