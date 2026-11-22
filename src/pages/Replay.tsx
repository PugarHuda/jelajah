import { useEffect, useState } from 'react';
import { hexToBin } from '@bitauth/libauth';
import { rally, provider, minters, vault } from '../chain';
import { loadCycle, type Step } from '../lib/replay';
import { explorerTx, addressOf } from '../wallet';
import { sats, tr, back, explain } from '../shared';
import { CYCLE, LEVY_MAINNET } from '../cycle';

const who = (pkh: string) => addressOf(hexToBin(`76a914${pkh}88ac`)).replace(/^(.{20}).*(.{6})$/, '$1…$2');

// ---- #/replay: a judge sees one whole set on BCH mainnet in a minute, no wallet, no sats: each click opens the next
// real transaction, decoded live from the chain (src/lib/replay.ts).
export function Replay() {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const here = rally.category === LEVY_MAINNET; // the recorded set belongs to the live mainnet rally
  useEffect(() => {
    if (!here) return;
    loadCycle({ provider, rally, vaultAddress: vault.address, minterAddresses: Object.values(minters).map((m) => m.address), ...CYCLE })
      .then(setSteps).catch((e) => setErr(explain(e)));
  }, [here]);
  const s = steps?.[i];
  return (
    <main className="organize replay">
      <p className="eyebrow">{rally.name} · BCH mainnet · {tr('no wallet needed', 'tanpa wallet')}</p>
      <h1>{tr('One full set, transaction by transaction', 'Satu set penuh, transaksi demi transaksi')}</h1>
      <p className="lede">{tr('These are the real transactions of one set on mainnet, read and decoded from the chain as you watch. Every number below comes from them.', 'Ini transaksi asli satu set di mainnet, dibaca dan didekode dari chain saat kamu melihatnya. Semua angka di bawah berasal dari transaksi itu.')}</p>
      {!here && <p className="hint">{tr('The recorded set belongs to the live mainnet rally:', 'Set rekaman ini milik rally mainnet:')} <a href={`${location.pathname}#/replay`}>{tr('watch it there →', 'tonton di sana →')}</a></p>}
      {err && <p className="error" role="alert">{err}</p>}
      {here && !steps && !err && <p className="muted">{tr('Reading the chain…', 'Membaca chain…')}</p>}
      {steps && s && (<>
        <ol className="dots" aria-label={tr('Steps', 'Langkah')}>{steps.map((x, k) => <li key={x.txid} className={k === i ? 'on' : k < i ? 'done' : ''}><button className="ghost" onClick={() => setI(k)} aria-label={`${tr('Step', 'Langkah')} ${k + 1}`} aria-current={k === i ? 'step' : undefined}>{k + 1}</button></li>)}</ol>
        <section className="claim ready" aria-live="polite">
          <div>
            {s.kind === 'stamp' && (<>
              <h2>{s.emoji} {tr(`Stamp at ${s.stall}`, `Stamp di ${s.stall}`)}</h2>
              <ul>
                <li>💸 <b>{sats(s.toStall)}</b> {tr(`paid to ${s.stall}`, `dibayar ke ${s.stall}`)}</li>
                <li>🏦 <b>{sats(s.levy)}</b> {tr('levy into the prize pool (the vault contract)', 'levy masuk pool hadiah (kontrak vault)')}</li>
                <li>🎫 {tr(`the ${s.stall} stamp NFT, minted in this same transaction to`, `NFT stamp ${s.stall}, dicetak di transaksi yang sama ini untuk`)} <code>{who(s.buyer)}</code></li>
                {s.minterBack && <li>🔁 {tr("the stall's minter coin went straight back to its covenant, ready for the next buyer", 'koin minter warung langsung kembali ke covenant-nya, siap untuk pembeli berikutnya')}</li>}
              </ul>
            </>)}
            {s.kind === 'merge' && (<>
              <h2>🏦 {tr('The levies join the pool', 'Levy bergabung ke pool')}</h2>
              <ul>
                <li>{tr('Pool before', 'Pool sebelum')}: <b>{sats(s.before)}</b></li>
                <li>{tr(`${s.levies.length} levies`, `${s.levies.length} levy`)}: <b>{s.levies.map((x) => sats(x)).join(' + ')}</b></li>
                <li>{tr('Pool after', 'Pool sesudah')}: <b>{sats(s.after)}</b></li>
                <li>⛏️ {(() => { const fee = s.before + s.levies.reduce((a, b) => a + b, 0n) - s.after; return tr(`${sats(fee)} went to the miner as the fee: the covenant lets a merge spend up to 1,000 sats per coin, which is why the rally's rules make each set's levies cover its reward after that cost.`, `${sats(fee)} jadi fee untuk miner: covenant mengizinkan merge memakai sampai 1.000 sats per koin, karena itu aturan rally mewajibkan levy tiap set menutup hadiahnya setelah biaya itu.`); })()}</li>
                <li>✍️ {tr('No signature: anyone can fold levies in, and only into the pool.', 'Tanpa tanda tangan: siapa pun bisa menggabungkan levy, dan hanya ke pool.')}</li>
              </ul>
            </>)}
            {s.kind === 'claim' && (<>
              <h2>🏆 {tr('The set is claimed', 'Set diklaim')}</h2>
              <ul>
                <li>🔥 {tr('Burned', 'Dibakar')}: <b>{s.burned.join(' · ')}</b> {tr(`(${s.burned.length} different stalls, checked by the vault)`, `(${s.burned.length} warung berbeda, dicek oleh vault)`)}</li>
                <li>🏦 {tr('Pool', 'Pool')}: {sats(s.before)} → {sats(s.after)}, {tr('so the reward paid was', 'jadi hadiah yang dibayar')} <b>{sats(s.before - s.after)}</b></li>
                <li>🏆 {tr('Trophy NFT minted to', 'NFT trofi dicetak untuk')} <code>{who(s.trophyTo)}</code>{tr(': also a member card for lower prices at every stall', ': sekaligus kartu member untuk harga lebih murah di semua warung')}</li>
                {(() => {
                  const merge = steps.find((x) => x.kind === 'merge') as Extract<Step, { kind: 'merge' }>;
                  const levies = merge.levies.reduce((a, b) => a + b, 0n), fee = merge.before + levies - merge.after, reward = s.before - s.after;
                  return <li>⚖️ {tr(`This set put ${sats(levies)} of levies in; ${sats(fee)} went to the merge fee and ${sats(reward)} to the reward, so ${sats(levies - fee - reward)} stayed in the pool. It paid for its own reward.`, `Set ini memasukkan levy ${sats(levies)}; ${sats(fee)} untuk fee merge dan ${sats(reward)} untuk hadiah, jadi ${sats(levies - fee - reward)} tetap di pool. Hadiahnya dibiayai sendiri.`)}</li>;
                })()}
              </ul>
            </>)}
            <p className="small"><a href={explorerTx(s.txid)} target="_blank" rel="noreferrer">{tr('Open this transaction on the explorer', 'Buka transaksi ini di explorer')} ({s.txid.slice(0, 12)}…) →</a></p>
          </div>
        </section>
        <p className="row">
          <button className="ghost" disabled={i === 0} onClick={() => setI(i - 1)}>← {tr('Back', 'Kembali')}</button>
          {i < steps.length - 1
            ? <button className="primary" onClick={() => setI(i + 1)}>{tr('Next transaction', 'Transaksi berikutnya')} →</button>
            : <a className="button primary" href="#">{tr('Now try it yourself →', 'Sekarang coba sendiri →')}</a>}
        </p>
        <p className="muted small">{tr("Honest note: this set was our own test purchase, so the buyer and the demo stalls share the organizer's address. A real rally gives each stall its own address (set them on #/organize).", 'Catatan jujur: set ini pembelian tes kami sendiri, jadi pembeli dan warung demo memakai alamat organizer yang sama. Rally sungguhan memberi tiap warung alamatnya sendiri (atur di #/organize).')}</p>
      </>)}
      {back}
    </main>
  );
}
