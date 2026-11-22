import { useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { secp256k1, generatePrivateKey, encodePrivateKeyWif, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import { TransactionBuilder } from 'cashscript';
import { rally, provider } from '../chain';
import { sponsorPool } from '../lib/tx.js';
import { buyerLock, walletCoins, signAndSend, addressOf, explorerTx, type Coin } from '../wallet';
import { sats, tr, qrImage, back, wcSubtitle, explain } from '../shared';

const PER_LINK = 2000n; // sats riding with each voucher: enough to pay the network fee when the buyer takes it

// ---- #/sponsor: a sponsor (a tourism office, a brand) turns the vouchers in its wallet into gift links, one voucher each.
// One transaction splits them out; each link is a #/gift/<key> page, so the buyer takes the voucher into their wallet
// and the next stamp costs sponsor.value less, while the stall still gets its full price (SponsorPool pays the gap).
export function Sponsor() {
  const sp = rally.sponsor;
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [n, setN] = useState('3');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [links, setLinks] = useState<{ txid: string; urls: string[] } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  // the sponsor's dashboard, from the chain: what is left in the subsidy pool
  const [pool, setPool] = useState<{ coins: number; sats: bigint; address: string } | null>(null);
  useEffect(() => {
    const c = sponsorPool(rally, provider);
    if (c) c.getUtxos().then((u: { satoshis: bigint }[]) => setPool({ coins: u.length, sats: u.reduce((s, x) => s + x.satoshis, 0n), address: c.address })).catch(() => {});
  }, []);
  useEffect(() => { if (lock) walletCoins(wc.manager!).then(setCoins).catch((e) => setErr(String(e))); }, [lock, wc.manager]);

  if (!sp) return <main className="organize"><h1>{tr('Sponsor vouchers', 'Voucher sponsor')}</h1><p>{tr('This rally has no sponsor.', 'Rally ini tidak punya sponsor.')}</p>{back}</main>;
  const vouchers = (coins ?? []).filter((c) => c.utxo.token?.category === sp.category && !c.utxo.token.nft);
  const held = vouchers.reduce((s, c) => s + c.utxo.token!.amount, 0n);
  const count = Math.floor(Number(n));
  const ok = count >= 1 && count <= 20 && BigInt(count) <= held;

  async function make() {
    setErr(null); setBusy(true);
    try {
      const plain = (coins ?? []).filter((c) => !c.utxo.token);
      const keys = Array.from({ length: count }, () => generatePrivateKey());
      const tb = new TransactionBuilder({ provider });
      const inputs = [...vouchers, ...plain];
      inputs.forEach((c) => tb.addInput(c.utxo, c.unlocker));
      for (const k of keys) {
        const to = addressOf(encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(k) as Uint8Array)), true);
        tb.addOutput({ to, amount: PER_LINK, token: { category: sp!.category, amount: 1n } });
      }
      const total = inputs.reduce((s, c) => s + c.utxo.satoshis, 0n);
      const back = held - BigInt(count);
      if (back > 0n) tb.addOutput({ to: addressOf(lock!, true), amount: 1000n, token: { category: sp!.category, amount: back } });
      const change = total - PER_LINK * BigInt(count) - (back > 0n ? 1000n : 0n) - 300n - 160n * BigInt(inputs.length) - 70n * BigInt(count);
      if (change < 0n) throw new Error(tr(`Your wallet needs about ${sats(-change)} more`, `Wallet-mu kurang sekitar ${sats(-change)}`));
      if (change >= 546n) tb.addOutput({ to: addressOf(lock!), amount: change });
      const txid = await signAndSend(wc.manager!, tb, inputs, tr(`Split ${count} ${sp!.name} vouchers into gift links`, `Pecah ${count} voucher ${sp!.name} jadi link hadiah`), 0);
      const base = `${location.origin}${location.pathname}${location.search}#/gift/`;
      setLinks({ txid, urls: keys.map((k) => base + encodePrivateKeyWif(k, rally.network === 'mainnet' ? 'mainnet' : 'testnet')) });
    } catch (e) { setErr(explain(e)); } finally { setBusy(false); }
  }

  return (
    <main className="organize">
      <p className="eyebrow">{rally.name} · {tr('for sponsors', 'untuk sponsor')}</p>
      <h1>🎟 {tr('Hand out vouchers', 'Bagikan voucher')}</h1>
      <p className="lede">{tr(`Each voucher takes ${sats(sp.value)} off one stamp, paid from your subsidy pool, so the stall still gets its full price. Turn the vouchers in your wallet into links: one link, one voucher. Send them to newsletter sign-ups, print them on flyers, give them at the tourist desk.`,
        `Tiap voucher memotong ${sats(sp.value)} dari satu stamp, dibayar dari pool subsidimu, jadi warung tetap menerima harga penuh. Ubah voucher di wallet-mu jadi link: satu link, satu voucher. Kirim ke pendaftar newsletter, cetak di brosur, bagikan di meja informasi wisata.`)}</p>
      {pool && <p className="hint">📊 {tr(`Subsidy pool: ${pool.coins} sponsored stamp${pool.coins === 1 ? '' : 's'} left (${sats(pool.sats)}).`, `Pool subsidi: sisa ${pool.coins} stamp bersponsor (${sats(pool.sats)}).`)} <a href={`${rally.network === 'mainnet' ? 'https://blockchair.com/bitcoin-cash/address/' : 'https://chipnet.imaginary.cash/address/'}${pool.address}`} target="_blank" rel="noreferrer">{tr('Every use, on chain →', 'Setiap pemakaian, di chain →')}</a></p>}
      <p className="muted small">{tr('Sponsor', 'Sponsor')}: <b>{sp.name}</b> · {tr('voucher category', 'kategori voucher')} <code className="wrap">{sp.category}</code></p>
      {links ? (
        <div className="claim ready"><div>
          <h3>✅ {tr(`${links.urls.length} voucher link${links.urls.length === 1 ? '' : 's'}`, `${links.urls.length} link voucher`)} · <a href={explorerTx(links.txid)} target="_blank" rel="noreferrer">{links.txid.slice(0, 16)}…</a></h3>
          <p className="warn small">{tr('Each link IS a voucher: whoever opens it first takes it. Share them privately.', 'Tiap link ADALAH voucher: siapa pun yang membukanya lebih dulu bisa mengambilnya. Bagikan secara pribadi.')}</p>
          <textarea className="code" readOnly rows={Math.min(links.urls.length, 6)} value={links.urls.join('\n')} aria-label={tr('Voucher links', 'Link voucher')} />
          <div className="vouchers">{links.urls.map((u, i) => <figure key={u}><img className="qr small" src={qrImage(u)} alt={tr(`Voucher ${i + 1}`, `Voucher ${i + 1}`)} /><figcaption>🎟 #{i + 1}</figcaption></figure>)}</div>
        </div></div>
      ) : lock ? (<>
        <p>{coins === null ? tr('Reading your wallet…', 'Membaca wallet-mu…') : tr(`Your wallet holds ${held} voucher${held === 1n ? '' : 's'}.`, `Wallet-mu memegang ${held} voucher.`)}</p>
        <div className="form"><label>{tr('Links to make (1–20)', 'Jumlah link (1–20)')}<input type="number" min={1} max={20} value={n} onChange={(e) => setN(e.target.value)} /></label></div>
        <button className="primary big" disabled={!ok || busy} onClick={make}>{busy ? tr('Approve in wallet…', 'Setujui di wallet…') : tr(`Make ${count || 0} voucher link${count === 1 ? '' : 's'}`, `Buat ${count || 0} link voucher`)}</button>
      </>) : (
        <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect the sponsor wallet', 'Hubungkan wallet sponsor')}</button>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={wcSubtitle()} />}
      {back}
    </main>
  );
}
