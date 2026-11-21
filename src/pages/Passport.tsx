import { useEffect, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import { provider, passportFromLink } from '../chain';
import { buildPassportClaim, isTrophyOf } from '../lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, type Coin } from '../wallet';
import { sats, tr, hex } from '../shared';

// ---- #/passport (?pp=…): trade a trophy from each of two rallies for the passport reward + a Passport NFT
export function PassportPage() {
  const pp = passportFromLink!;
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: new URL('favicon.svg', location.origin + import.meta.env.BASE_URL).href });
  const lock = wc.state === 'connected' ? buyerLock(wc.manager) : null;
  const [coins, setCoins] = useState<Coin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { // xpubs can land after "connected"
    if (wc.state !== 'connected' || lock) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [wc.state, lock]);
  useEffect(() => { if (lock) walletCoins(wc.manager!).then(setCoins).catch(() => {}); }, [lock, wc.manager]);
  const pkh = lock ? hex(lock.slice(3, 23)) : '';
  const a = coins?.find((c) => isTrophyOf(pp.rallyA.category, pkh, c.utxo));
  const b = coins?.find((c) => isTrophyOf(pp.rallyB.category, pkh, c.utxo));
  async function claim() {
    setBusy(true); setErr(null);
    try {
      const fresh = await walletCoins(wc.manager!);
      const { builder, inputs } = await buildPassportClaim({ passport: pp, provider, ownerLock: lock!, coins: fresh.filter((c) => !c.utxo.token),
        trophyA: fresh.find((c) => isTrophyOf(pp.rallyA.category, pkh, c.utxo)), trophyB: fresh.find((c) => isTrophyOf(pp.rallyB.category, pkh, c.utxo)) });
      setDone(await signAndSend(wc.manager!, builder, inputs, tr(`Trade your two trophies for the ${pp.name} passport + ${sats(pp.reward)}`, `Tukar dua trofimu dengan paspor ${pp.name} + ${sats(pp.reward)}`)));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return (
    <main className="organize">
      <p className="eyebrow">{pp.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'} · {tr('passport', 'paspor')}</p>
      <h1>🛂 {pp.name}</h1>
      <p className="lede">{tr(`Finished both "${pp.rallyA.name}" and "${pp.rallyB.name}"? Trade one trophy from each for ${sats(pp.reward)} and a Passport NFT. The trophies are burned, so each pair counts once.`,
        `Sudah menyelesaikan "${pp.rallyA.name}" dan "${pp.rallyB.name}"? Tukar satu trofi dari masing-masing dengan ${sats(pp.reward)} dan NFT Paspor. Trofinya dibakar, jadi setiap pasangan hanya berlaku sekali.`)}</p>
      {done ? <p className="hint">✅ <a href={explorerTx(done)} target="_blank" rel="noreferrer">{done.slice(0, 16)}…</a></p>
        : !lock ? <button className="primary big" onClick={wc.connect} disabled={wc.state === 'connecting' || wc.state === 'connected'}>{wc.state === 'connected' ? tr('Loading wallet…', 'Memuat wallet…') : tr('Connect wallet', 'Hubungkan wallet')}</button>
        : (<>
          <ul>
            <li>{a ? '🏆' : '·'} {pp.rallyA.name}</li>
            <li>{b ? '🏆' : '·'} {pp.rallyB.name}</li>
          </ul>
          <button className="primary big" disabled={!a || !b || busy} onClick={claim}>{busy ? tr('Approve in wallet…', 'Setujui di wallet…') : tr('Get my passport', 'Ambil pasporku')}</button>
        </>)}
      {err && <p className="error" role="alert">{err}</p>}
      {wc.uri && wc.qrUri && <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri} title="WizardConnect" subtitle={tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca')} />}
    </main>
  );
}
