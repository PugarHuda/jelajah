import { useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { secp256k1, generatePrivateKey, encodePrivateKeyWif, decodePrivateKeyWif, encodeLockingBytecodeP2pkh, hash160 } from '@bitauth/libauth';
import { TransactionBuilder, SignatureTemplate } from 'cashscript';
import { rally, provider } from '../chain';
import { buyerLock, explorerTx, addressOf } from '../wallet';
import { sats, tr, qrImage, back } from '../shared';

// ---- #/gift/<wif>: a gift link holding a few sats, so someone with an empty wallet can buy their first stamp.
// The key lives only in the link's #fragment, which browsers never send to a server. Whoever opens it first can take it.
export function Gift() {
  const [wif] = useState(() => {
    const w = location.hash.slice('#/gift/'.length);
    if (w) return w;
    const made = encodePrivateKeyWif(generatePrivateKey(), rally.network === 'mainnet' ? 'mainnet' : 'testnet');
    history.replaceState(null, '', `${location.pathname}${location.search}#/gift/${made}`); // a reload keeps the same key
    return made;
  });
  const key = decodePrivateKeyWif(wif);
  const giftLock = typeof key === 'string' ? null : encodeLockingBytecodeP2pkh(hash160(secp256k1.derivePublicKeyCompressed(key.privateKey) as Uint8Array));
  const address = giftLock ? addressOf(giftLock) : '';
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [vouchers, setVouchers] = useState(0n); // a sponsor's voucher links (#/sponsor) are gifts carrying one voucher
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    const look = () => provider.getUtxos(address).then((u) => {
      setBalance(u.reduce((s, x) => s + x.satoshis, 0n));
      setVouchers(u.filter((x) => rally.sponsor && x.token?.category === rally.sponsor.category && !x.token.nft).reduce((s, x) => s + x.token!.amount, 0n));
    }).catch(() => {});
    look();
    const t = setInterval(look, 6000);
    return () => clearInterval(t);
  }, [address]);
  async function take() {
    setErr(null);
    try {
      if (typeof key === 'string') throw new Error(key);
      const coins = await provider.getUtxos(address);
      const plain = coins.filter((u) => !u.token), tokens = coins.filter((u) => u.token);
      const total = plain.reduce((s, u) => s + u.satoshis, 0n);
      const fee = 200n + 150n * BigInt(coins.length) + 70n * BigInt(tokens.length);
      const sig = new SignatureTemplate(key.privateKey);
      const tb = new TransactionBuilder({ provider });
      coins.forEach((u) => tb.addInput(u, sig.unlockP2PKH()));
      // tokens (a sponsor's voucher) keep their category and amount; the fee comes from plain sats, else from the first token coin
      const feeFromToken = total - fee < 546n;
      tokens.forEach((u, i) => tb.addOutput({ to: addressOf(lock!, true), amount: u.satoshis - (feeFromToken && i === 0 ? fee - total : 0n), token: u.token }));
      if (feeFromToken && (!tokens.length || tokens[0].satoshis - (fee - total) < 1000n)) throw new Error(tr('This gift is empty (or already taken).', 'Hadiah ini kosong (atau sudah diambil).'));
      if (!feeFromToken) tb.addOutput({ to: lock!, amount: total - fee });
      setDone((await tb.send()).txid);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }
  if (!giftLock) return <main className="organize"><p className="error">{tr('This gift link is broken.', 'Link hadiah ini rusak.')}</p>{back}</main>;
  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('gift link', 'link hadiah')}</p>
      <h1>🎁 {balance ? sats(balance) : tr('A Jelajah gift', 'Hadiah Jelajah')}{vouchers > 0n && ` + ${vouchers} voucher 🎟`}</h1>
      {vouchers > 0n && rally.sponsor && <p className="hint">{tr(`From ${rally.sponsor.name}: each voucher takes ${sats(rally.sponsor.value)} off a stamp, and the stall still gets its full price.`, `Dari ${rally.sponsor.name}: tiap voucher memotong ${sats(rally.sponsor.value)} dari satu stamp, dan warung tetap dibayar penuh.`)}</p>}
      {done ? <p className="hint">✅ {tr('In your wallet', 'Sudah di wallet-mu')}: <a href={explorerTx(done)} target="_blank" rel="noreferrer">{done.slice(0, 16)}…</a>. <a href={location.pathname + location.search}>{tr('Now buy your first stamp →', 'Sekarang beli stamp pertamamu →')}</a></p>
        : balance ? (lock
          ? <button className="primary big" onClick={take}>{tr(`Take ${sats(balance)} into my wallet`, `Ambil ${sats(balance)} ke wallet-ku`)}</button>
          : <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet to take it', 'Hubungkan wallet untuk mengambilnya')}</button>)
        : <p className="muted">{balance === null ? tr('Checking…', 'Mengecek…') : tr('Empty: fund it below, or it was already taken.', 'Kosong: isi di bawah, atau sudah diambil.')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <details className="small" open={balance === 0n}>
        <summary>{tr('Make a gift', 'Buat hadiah')}</summary>
        <p>{tr('1. Send a few thousand sats to this address (enough for one stamp or more):', '1. Kirim beberapa ribu sats ke alamat ini (cukup untuk satu stamp atau lebih):')}</p>
        <img className="qr small" src={qrImage(address)} alt={address} /><br /><code className="wrap">{address}</code>
        <p>{tr('2. Share this page’s link. The link IS the money: whoever opens it first can take it, so send it privately.', '2. Bagikan link halaman ini. Link ini adalah uangnya: siapa pun yang membukanya lebih dulu bisa mengambilnya, jadi kirim secara pribadi.')}</p>
        <code className="wrap">{location.href}</code>
        <p className="muted">{tr('Changed your mind? Open the link yourself and take it back.', 'Berubah pikiran? Buka link-nya sendiri dan ambil kembali.')}</p>
      </details>
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />}
      {back}
    </main>
  );
}
