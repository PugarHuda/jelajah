import { useEffect, useState } from 'react';
import { binToHex, cashAddressToLockingBytecode, secp256k1, decodePrivateKeyWif, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';
import { rally, provider, vault, rallyLink, type Rally } from '../chain';
import { buildReclaim, buildAddStall } from '../lib/tx.js';
import { explorerTx, addressOf } from '../wallet';
import { LOADED_AT, sats, tr, reclaimStoreKey } from '../shared';

// ---- #/reclaim: after a rally ends, its organizer takes back what is left of the pool. Signed locally with the rally's
// reclaim key (created on #/organize and kept in this browser, or pasted from the backup); no wallet prompt needed.
const MTP_LAG = 3600; // nodes check a time locktime against the median time past, about an hour behind the clock

export function Reclaim() {
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
      <p><a href={location.pathname + location.search}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
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
