import { useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { RELAYS, NIP39_KIND, buildProofTx, linkEvent, nip39Event, findVerified, loginChallenge, loginEvent, checkLogin } from '../lib/identity.js';
import { rally, provider, officialRallies } from '../chain';
import { isRallyNft } from '../lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, addressOf } from '../wallet';
import { tr, type NostrSigner, nostrSigner, wcSubtitle, explain } from '../shared';

// ---- #/identity: Jelajah ID — link your BCH address and a Nostr key (each vouching for the other), find and verify
// anyone's link from public relays + the chain, see their Jelajah reputation, pay them, and log in by challenge.
export function IdentityPage() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  useEffect(() => { nostrSigner().then(setSigner).catch(() => {}); }, []);
  const address = lock ? addressOf(lock) : null;
  const [busy, setBusy] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ txid: string; relays: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ ok: boolean; address?: string; nostrPubkey?: string; txid?: string; reason?: string; stamps?: number; trophies?: number } | null>(null);
  const [login, setLogin] = useState<{ address?: string; note?: string } | null>(null);

  async function link() {
    setErr(null);
    try {
      setBusy(tr('Approve the proof in your wallet…', 'Setujui bukti di wallet…'));
      const coins = (await walletCoins(wc.manager!)).filter((c) => c.path[0] === 'receive' && c.path[1] === 0 && !c.utxo.token);
      const { builder, inputs } = buildProofTx({ provider, coins, address: address!, nostrPubkey: signer!.pubkey });
      const txid = await signAndSend(wc.manager!, builder, inputs, tr('Prove this address is yours for your Nostr key (Jelajah ID)', 'Buktikan alamat ini milikmu untuk kunci Nostr-mu (Jelajah ID)'), 0);
      setBusy(tr('Signing and publishing on Nostr…', 'Menandatangani dan menerbitkan di Nostr…'));
      const event = await signer!.sign(linkEvent({ address: address!, nostrPubkey: signer!.pubkey, txid, network: rally.network }));
      const pool = new SimplePool();
      const res = await Promise.allSettled(pool.publish(RELAYS, event));
      // also a standard NIP-39 claim, keeping the other claims in this key's list
      const [current] = (await pool.querySync(RELAYS, { kinds: [NIP39_KIND], authors: [signer!.pubkey] }, { maxWait: 4000 })).sort((a, b) => b.created_at - a.created_at);
      await Promise.allSettled(pool.publish(RELAYS, await signer!.sign(nip39Event(current, { address: address!, txid }))));
      pool.close(RELAYS);
      setLinked({ txid, relays: res.filter((r) => r.status === 'fulfilled').length });
    } catch (e) { setErr(explain(e)); } finally { setBusy(null); }
  }

  async function verify() {
    setErr(null); setFound(null); setBusy(tr('Searching public relays…', 'Mencari di relay publik…'));
    try {
      const q = query.trim();
      const pool = new SimplePool();
      const r = await findVerified(pool, q.includes(':') ? { address: q } : { nostrPubkey: q.startsWith('npub') ? (nip19.decode(q).data as string) : q }, provider);
      pool.close(RELAYS);
      if (r.ok) { // reputation that travels: this rally's stamps and trophies held by the verified address
        const held = (await provider.getUtxos(r.address!)).filter((u) => officialRallies.some((x) => isRallyNft(x, u)));
        setFound({ ...r, stamps: held.filter((u) => !u.token!.nft!.commitment.startsWith('00')).length, trophies: held.filter((u) => u.token!.nft!.commitment.startsWith('00')).length });
      } else setFound(r);
    } catch (e) { setErr(explain(e)); } finally { setBusy(null); }
  }

  async function doLogin() {
    setErr(null); setLogin(null);
    try {
      const challenge = loginChallenge(); // a real app would issue this and remember it
      const answer = await signer!.sign(loginEvent(challenge, location.origin));
      const problem = checkLogin(answer, challenge, location.origin);
      if (problem) throw new Error(problem);
      const pool = new SimplePool();
      const r = await findVerified(pool, { nostrPubkey: answer.pubkey }, provider);
      pool.close(RELAYS);
      setLogin(r?.ok ? { address: r.address! } : { note: tr('Signature OK, but no verified BCH link yet. Link first.', 'Tanda tangan OK, tapi belum ada tautan BCH terverifikasi. Tautkan dulu.') });
    } catch (e) { setErr(explain(e)); }
  }

  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · Jelajah ID</p>
      <h1>{tr('One identity across Bitcoin Cash and Nostr', 'Satu identitas di Bitcoin Cash dan Nostr')}</h1>
      <p className="lede">{tr('Your wallet proves the BCH address by spending from it with your Nostr key in the OP_RETURN; your Nostr key signs a statement naming that address and proof. Anyone can find it on public relays and check both sides, without any server.',
        'Wallet-mu membuktikan alamat BCH dengan membelanjakan koin darinya, berisi kunci Nostr-mu di OP_RETURN; kunci Nostr-mu menandatangani pernyataan yang menyebut alamat dan bukti itu. Siapa pun bisa menemukannya di relay publik dan mengecek kedua sisi, tanpa server.')}</p>

      <h2>1 · {tr('Link yours', 'Tautkan milikmu')}</h2>
      <p className="muted small">Nostr: <code className="wrap">{signer ? nip19.npubEncode(signer.pubkey) : '…'}</code> {signer && !(window as unknown as { nostr?: unknown }).nostr && tr('(a key made in this browser; with a NIP-07 extension your own key is used)', '(kunci yang dibuat di browser ini; dengan ekstensi NIP-07 kuncimu sendiri yang dipakai)')}</p>
      {address ? <p className="muted small">BCH: <code className="wrap">{address}</code></p> : null}
      {linked ? <p className="hint">✅ {tr('Linked', 'Tertaut')}: <a href={explorerTx(linked.txid)} target="_blank" rel="noreferrer">{linked.txid.slice(0, 16)}…</a> · {tr(`published to ${linked.relays} relays`, `terbit di ${linked.relays} relay`)}</p>
        : address ? <button className="primary" disabled={!signer || !!busy} onClick={link}>{busy ?? tr('Link my BCH address and Nostr key', 'Tautkan alamat BCH dan kunci Nostr-ku')}</button>
        : <button className="primary" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>}
      <p className="muted small">{tr('The proof spends a coin at your first receive address (a few hundred sats of fee).', 'Bukti membelanjakan koin di alamat terima pertamamu (fee beberapa ratus sats).')}</p>

      <h2>2 · {tr('Find and verify anyone', 'Cari dan verifikasi siapa pun')}</h2>
      <div className="form"><label className="wide">{tr('npub, Nostr hex key, or BCH address', 'npub, kunci Nostr hex, atau alamat BCH')}<input className="code" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="npub1… / bitcoincash:q…" /></label></div>
      <button className="ghost" disabled={!query.trim() || !!busy} onClick={verify}>{tr('Verify', 'Verifikasi')}</button>
      {found && (found.ok
        ? <div className="claim ready"><div>
          <h3>✅ {tr('Verified', 'Terverifikasi')}</h3>
          <p className="small">{nip19.npubEncode(found.nostrPubkey!)} ⇄ <code className="wrap">{found.address}</code></p>
          <p className="muted small">{tr('BCH proof', 'Bukti BCH')} <a href={explorerTx(found.txid!)} target="_blank" rel="noreferrer">{found.txid!.slice(0, 16)}…</a> · {tr(`Jelajah (${officialRallies.length} rallies)`, `Jelajah (${officialRallies.length} rally)`)}: {found.stamps} stamp, {found.trophies} 🏆</p>
          <p className="small"><a href={`${found.address}?message=${encodeURIComponent('via Jelajah ID')}`}>{tr('Pay this identity in your wallet →', 'Bayar identitas ini di wallet-mu →')}</a></p>
        </div></div>
        : <p className="error">✗ {found.reason}</p>)}

      <h2>3 · {tr('Log in with it', 'Login dengannya')}</h2>
      <p className="muted small">{tr("An app hands out a challenge, your Nostr key signs it, and the app looks up your verified BCH address: no password, no account, no identity provider.", 'Aplikasi memberi challenge, kunci Nostr-mu menandatanganinya, lalu aplikasi mencari alamat BCH-mu yang terverifikasi: tanpa password, tanpa akun, tanpa penyedia identitas.')}</p>
      <button className="ghost" disabled={!signer} onClick={doLogin}>{tr('Log in with Jelajah ID', 'Login dengan Jelajah ID')}</button>
      {login && <p className="hint">{login.address ? `✅ ${tr('Logged in as', 'Masuk sebagai')} ${login.address}` : login.note}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={wcSubtitle()} />}
      <p><a href={location.pathname + location.search}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}
