import { useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { binToHex, cashAddressToLockingBytecode, secp256k1, generatePrivateKey, encodePrivateKeyWif } from '@bitauth/libauth';
import { TransactionBuilder } from 'cashscript';
import { SimplePool } from 'nostr-tools/pool';
import { RELAYS, rallyEvent } from '../lib/identity.js';
import { rally, provider, rallyLink, type Rally } from '../chain';
import { bcmrRegistry, checkRallyConfig, genesisNeed, planRally, buildGenesis } from '../lib/tx.js';
import { buyerLock, walletCoins, signAndSend, receiveZeroCoin } from '../wallet';
import { sats, tr, reclaimStoreKey, nostrSigner } from '../shared';

// ---- #/organize: open your own rally from the browser. The genesis is the same code the CLI uses (src/lib/tx.js),
// signed by the organizer's wallet over WizardConnect; the finished rally travels in its share link.
const PALETTE = ['#7a4a2b', '#c2410c', '#b91c1c', '#15803d', '#1d4ed8', '#7e22ce'];
type StallRow = { name: string; emoji: string; price: string; memberPrice: string; address: string; presenceKey?: string; place?: string };

export function Organize() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  const [f, setF] = useState({ name: '', needed: '3', reward: '4000', rewardsInPool: '2', durationDays: '30', levy: '', bonusNeeded: '', bonusReward: '', streakDays: '', streakReward: '', bcmrUrl: '' });
  const [bcmrBody, setBcmrBody] = useState<string | null>(null);
  const [stalls, setStalls] = useState<StallRow[]>([
    { name: '', emoji: '🍜', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '☕', price: '5000', memberPrice: '4500', address: '' },
    { name: '', emoji: '🍢', price: '5000', memberPrice: '4500', address: '' },
  ]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [reclaimWif, setReclaimWif] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; category: string } | null>(null);
  const [listed, setListed] = useState<number | null>(null);
  async function list() { // optional: put the rally on #/rallies (a Nostr event carrying the share link's payload)
    setErr(null);
    try {
      const signer = await nostrSigner();
      const event = await signer.sign(rallyEvent({ ...made!, network: rally.network, r: new URL(link!).searchParams.get('r')! }));
      const pool = new SimplePool();
      const res = await Promise.allSettled(pool.publish(RELAYS, event));
      pool.close(RELAYS);
      setListed(res.filter((r) => r.status === 'fulfilled').length);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  const payout = (address: string) => {
    if (!address.trim()) return lock ? binToHex(lock) : '76a914' + '00'.repeat(20) + '88ac'; // default: the organizer
    const r = cashAddressToLockingBytecode(address.trim());
    if (typeof r === 'string') throw new Error(tr(`Not a valid address: ${address}`, `Alamat tidak valid: ${address}`));
    return binToHex(r.bytecode);
  };
  const cfg = () => ({
    name: f.name.trim() || 'My rally', description: '', needed: Number(f.needed), reward: Number(f.reward),
    rewardsInPool: Number(f.rewardsInPool), durationDays: Number(f.durationDays), lanes: 2,
    ...(f.levy.trim() ? { levy: Number(f.levy) } : {}),
    ...(f.bonusNeeded.trim() ? { bonusNeeded: Number(f.bonusNeeded), bonusReward: Number(f.bonusReward) } : {}),
    // streak (StampMinter4 + RewardVault3): dated stamps, a reward for N days in a row; checkRallyConfig prices in backdating
    ...(f.streakDays.trim() ? { streakDays: Number(f.streakDays), streakReward: Number(f.streakReward) } : {}),
    merchants: stalls.map((s, i) => ({
      id: i + 1, name: s.name.trim() || `Stall ${i + 1}`, emoji: s.emoji || '⭐', tagline: '', color: PALETTE[i % PALETTE.length],
      price: Number(s.price), memberPrice: Number(s.memberPrice || s.price), lock: payout(s.address),
      ...(s.presenceKey?.trim() ? { presenceKey: s.presenceKey.trim().toLowerCase() } : {}),
      ...(s.place?.trim() ? { place: s.place.trim().slice(0, 80) } : {}),
    })),
  });
  let problem: string | null = null;
  let need = 0n;
  try { const c = cfg(); checkRallyConfig(c); need = genesisNeed(c); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  if (!problem && f.bcmrUrl.trim() && !/^https:\/\/[^\s]+\.json$/.test(f.bcmrUrl.trim())) problem = tr('The metadata URL must be https://… ending in .json', 'URL metadata harus https://… berakhiran .json');
  // organizer's fee in a levy rally, enforced by the contracts: levies above the reward stay in the pool until reclaim
  // (lower bound: RewardVault2.merge() lets at most 600 sats per input go to fees)
  const margin = f.levy.trim() ? Number(f.needed) * (Number(f.levy) - 600) - 600 - Number(f.reward) : 0;

  async function open() {
    setErr(null);
    try {
      const m = wc.manager!;
      const c = cfg();
      const coins = (await walletCoins(m)).filter((x) => !x.utxo.token);
      let base = coins.find((x) => x.utxo.vout === 0 && x.utxo.satoshis >= need);
      if (!base) { // the category id is the txid of a vout-0 coin: make one with a single send-to-self
        const total = coins.reduce((s, x) => s + x.utxo.satoshis, 0n);
        const fee = 200n + 160n * BigInt(coins.length);
        if (total - fee < need) throw new Error(tr(`Your wallet needs at least ${sats(need)} (has ${sats(total)})`, `Wallet-mu perlu minimal ${sats(need)} (ada ${sats(total)})`));
        setBusy(tr('Approve the preparation in your wallet…', 'Setujui transaksi persiapan di wallet…'));
        const tb = new TransactionBuilder({ provider });
        coins.forEach((x) => tb.addInput(x.utxo, x.unlocker));
        tb.addOutput({ to: lock!, amount: total - fee });
        const txid = await signAndSend(m, tb, coins, tr('Prepare one coin to open your Jelajah rally', 'Siapkan satu koin untuk membuka rally Jelajah'), 0);
        base = receiveZeroCoin(m, { txid, vout: 0, satoshis: total - fee });
      }
      // the rally's organizer key (for reclaim) is made here, not in the wallet: reclaim is then signed locally on #/reclaim
      const reclaimKey = generatePrivateKey();
      const r = planRally({ network: rally.network, cfg: c, organizerPub: binToHex(secp256k1.derivePublicKeyCompressed(reclaimKey) as Uint8Array), baseTxid: base.utxo.txid });
      // optional BCMR: wallets show the rally's names once the organizer hosts this file at that URL (hash locked in the genesis)
      const reg = f.bcmrUrl.trim() ? bcmrRegistry(r, f.bcmrUrl.trim(), 0, false) : null;
      const { builder } = buildGenesis({ provider, rally: r, rewardsInPool: c.rewardsInPool, base, organizerLock: lock!, bcmr: reg ?? undefined });
      const prize = sats(BigInt(r.reward) * BigInt(c.rewardsInPool));
      setBusy(tr('Approve the rally in your wallet…', 'Setujui pembukaan rally di wallet…'));
      const txid = await signAndSend(m, builder, [base], tr(`Open the rally "${r.name}" and lock ${prize} of prizes`, `Buka rally "${r.name}" dan kunci hadiah ${prize}`), 0);
      const wif = encodePrivateKeyWif(reclaimKey, rally.network === 'mainnet' ? 'mainnet' : 'testnet');
      try { localStorage.setItem(reclaimStoreKey(r as Rally), wif); } catch { /* shown below for backup anyway */ }
      setReclaimWif(wif);
      setMade({ name: r.name, category: r.category });
      if (reg) setBcmrBody(reg.body);
      setLink(await rallyLink({ ...r, genesisTx: txid } as Rally));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const setStall = (i: number, k: keyof StallRow) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setStalls(stalls.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)));
  return (
    <main className="organize">
      <p className="eyebrow">{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('for organizers', 'untuk penyelenggara')}</p>
      <h1>{tr('Open your own rally', 'Buka rally-mu sendiri')}</h1>
      <p className="lede">{tr('Name the stalls, set prices and the prize. Your wallet signs one transaction that locks the prize pool in a covenant and gives every stall its stamp minter. Share the link it gives you.',
        'Isi warung, harga, dan hadiah. Wallet-mu menandatangani satu transaksi yang mengunci pool hadiah di covenant dan memberi tiap warung minter stamp-nya. Bagikan link yang muncul.')}</p>
      <p className="muted small">💼 {tr('How you earn, enforced by the contracts: in a levy rally every set’s levies exceed its reward, and that surplus comes back to you with reclaim after the end; and you can sell stall slots to new stalls while the rally runs.', 'Cara kamu mendapat untung, dijamin kontrak: di rally levy, levy tiap set melebihi hadiahnya, dan surplus itu kembali kepadamu lewat reclaim setelah rally berakhir; kamu juga bisa menjual slot ke warung baru selama rally berjalan.')}</p>
      {link ? (
        <div className="claim ready">
          <div>
            <h3>{tr('Your rally is live', 'Rally-mu sudah live')} 🎉</h3>
            <p className="small" style={{ wordBreak: 'break-all' }}><a href={link}>{link}</a></p>
            <p className="muted small">{tr('The rally lives in this link: save it. Stall posters: open the link and add #/stall/1, #/stall/2, …', 'Rally ada di dalam link ini, simpan baik-baik. Poster warung: buka link lalu tambahkan #/stall/1, #/stall/2, …')}</p>
            {listed === null
              ? <button className="ghost" onClick={list}>{tr('List it on Nostr (shows on #/rallies)', 'Daftarkan di Nostr (muncul di #/rallies)')}</button>
              : <p className="small">✅ {tr(`Listed on ${listed} relays`, `Terdaftar di ${listed} relay`)} · <a href="#/rallies">#/rallies</a></p>}
            {err && <p className="error" role="alert">{err}</p>}
            {bcmrBody && <p className="small">🪪 <a href={URL.createObjectURL(new Blob([bcmrBody], { type: 'application/json' }))} download="bcmr.json">{tr('Download bcmr.json', 'Unduh bcmr.json')}</a> {tr(`and host it, unchanged, at ${f.bcmrUrl.trim()}: wallets then show your rally's names (its hash is locked in the genesis).`, `lalu host apa adanya di ${f.bcmrUrl.trim()}: wallet akan menampilkan nama rally-mu (hash-nya terkunci di genesis).`)}</p>}
            {reclaimWif && <p className="warn small">🔑 <b>{tr('Back up your reclaim key.', 'Simpan kunci reclaim-mu.')}</b> {tr('It is the only way to take the leftover pool back after the rally ends (link + #/reclaim). It is also saved in this browser.', 'Hanya dengan kunci ini sisa pool bisa diambil setelah rally berakhir (link + #/reclaim). Kunci ini juga tersimpan di browser ini.')}<br /><code className="wrap">{reclaimWif}</code></p>}
            {reclaimWif && f.levy.trim() && <p className="small">🏪 {tr('More stalls want in after launch? Open the rally link + #/reclaim with this key and use “Open the stall”: the vault mints the new stall its minter on chain, so you can sell stall slots while the rally runs.', 'Ada warung lain yang mau ikut setelah rally jalan? Buka link rally + #/reclaim dengan kunci ini lalu pakai “Buka warung”: vault mencetak minter warung baru di chain, jadi kamu bisa menjual slot warung selama rally berjalan.')}</p>}
          </div>
        </div>
      ) : (<>
        <div className="form">
          <label>{tr('Rally name', 'Nama rally')}<input value={f.name} onChange={set('name')} placeholder="Jelajah Malioboro" maxLength={40} /></label>
          <label>{tr('Stamps for a set', 'Stamp untuk satu set')}<input type="number" min={1} value={f.needed} onChange={set('needed')} /></label>
          <label>{tr('Reward per set (sats)', 'Hadiah per set (sats)')}<input type="number" min={1} value={f.reward} onChange={set('reward')} /></label>
          <label>{tr('Rewards to fund now', 'Jumlah hadiah didanai')}<input type="number" min={1} value={f.rewardsInPool} onChange={set('rewardsInPool')} /></label>
          <label>{tr('Days open', 'Lama (hari)')}<input type="number" min={1} value={f.durationDays} onChange={set('durationDays')} /></label>
          <label>{tr('Levy per stamp (sats, optional)', 'Levy per stamp (sats, opsional)')}<input type="number" min={0} value={f.levy} onChange={set('levy')} placeholder={tr('none', 'tanpa')} /></label>
          <label>{tr('Bonus tier: stalls (optional, needs a levy)', 'Tingkat bonus: jumlah warung (opsional, perlu levy)')}<input type="number" min={2} value={f.bonusNeeded} onChange={set('bonusNeeded')} placeholder={tr('none', 'tanpa')} /></label>
          <label>{tr('Bonus reward (sats)', 'Hadiah bonus (sats)')}<input type="number" min={1} value={f.bonusReward} onChange={set('bonusReward')} disabled={!f.bonusNeeded.trim()} /></label>
          <label>{tr('🔥 Streak: days in a row (optional, needs a levy)', '🔥 Streak: hari berturut-turut (opsional, perlu levy)')}<input type="number" min={2} max={30} value={f.streakDays} onChange={set('streakDays')} placeholder={tr('none', 'tanpa')} /></label>
          <label>{tr('Streak reward (sats)', 'Hadiah streak (sats)')}<input type="number" min={1} value={f.streakReward} onChange={set('streakReward')} disabled={!f.streakDays.trim()} /></label>
          <label className="wide">{tr('Wallet metadata URL (optional: where you will host bcmr.json, e.g. GitHub Pages)', 'URL metadata wallet (opsional: tempat kamu akan meng-host bcmr.json, mis. GitHub Pages)')}<input value={f.bcmrUrl} onChange={set('bcmrUrl')} placeholder="https://you.github.io/rally/bcmr.json" /></label>
        </div>
        <h2>{tr('Stalls', 'Warung')}</h2>
        {stalls.map((s, i) => (
          <div className="form stall-row" key={i}>
            <label>{tr('Name', 'Nama')}<input value={s.name} onChange={setStall(i, 'name')} placeholder={`Stall ${i + 1}`} maxLength={40} /></label>
            <label>Emoji<input value={s.emoji} onChange={setStall(i, 'emoji')} maxLength={4} /></label>
            <label>{tr('Price', 'Harga')}<input type="number" min={546} value={s.price} onChange={setStall(i, 'price')} /></label>
            <label>{tr('Member price', 'Harga member')}<input type="number" min={546} value={s.memberPrice} onChange={setStall(i, 'memberPrice')} /></label>
            <label className="wide">{tr("Stall's BCH address (empty = yours)", 'Alamat BCH warung (kosong = milikmu)')}<input value={s.address} onChange={setStall(i, 'address')} placeholder="bitcoincash:q…" /></label>
            <label className="wide">{tr("Proof of presence: the stall device's key from #/device (optional, needs a levy)", 'Bukti kehadiran: kunci perangkat warung dari #/device (opsional, perlu levy)')}<input value={s.presenceKey ?? ''} onChange={setStall(i, 'presenceKey')} placeholder="02…" /></label>
            <label className="wide">{tr('Location (address or lat,lng; optional, shown as a map link)', 'Lokasi (alamat atau lat,lng; opsional, tampil sebagai link peta)')}<input value={s.place ?? ''} onChange={setStall(i, 'place')} placeholder="Jl. Malioboro, Yogyakarta" maxLength={80} /></label>
          </div>
        ))}
        <p className="row">
          <button className="ghost" onClick={() => setStalls([...stalls, { name: '', emoji: '⭐', price: '5000', memberPrice: '4500', address: '' }])} disabled={stalls.length >= 12}>+ {tr('Add a stall', 'Tambah warung')}</button>
          {stalls.length > 1 && <button className="ghost" onClick={() => setStalls(stalls.slice(0, -1))}>− {tr('Remove the last', 'Hapus yang terakhir')}</button>}
        </p>
        {problem ? <p className="error" role="alert">{problem}</p>
          : <p className="hint">{tr(`Your wallet will lock about ${sats(need)} (prize pool, one coin per stall lane, fees).`, `Wallet-mu akan mengunci sekitar ${sats(need)} (pool hadiah, satu koin per jalur warung, fee).`)}
            {margin > 0 && tr(` Your fee: every set's levies exceed its reward by at least ${sats(margin)}; that surplus stays in the pool and comes back to you with reclaim after the rally ends.`,
              ` Fee-mu: levy tiap set melebihi hadiahnya minimal ${sats(margin)}; surplus itu tertahan di pool dan kembali kepadamu lewat reclaim setelah rally berakhir.`)}</p>}
        {lock
          ? <button className="primary big" disabled={!!problem || !!busy} onClick={open}>{busy ?? tr('Open the rally', 'Buka rally')}</button>
          : <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>}
        {err && <p className="error" role="alert">{err}</p>}
        <p className="muted small">{tr('Anti-farming (reward below the cheapest set at member price) and, with a levy, anti-collusion are checked before your wallet is asked. Reclaiming the leftover pool after the rally ends is done with the CLI for now.',
          'Anti-farming (hadiah di bawah set termurah dengan harga member) dan, bila ada levy, anti-kolusi dicek sebelum wallet diminta tanda tangan. Mengambil sisa pool setelah rally berakhir saat ini lewat CLI.')}</p>
      </>)}
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri}
          title={tr('Connect with WizardConnect', 'Hubungkan lewat WizardConnect')} subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />
      )}
      <p><a href="#">{tr('← Back to the rally', '← Kembali ke rally')}</a></p>
    </main>
  );
}
