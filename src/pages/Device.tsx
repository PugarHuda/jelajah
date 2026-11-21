import { useEffect, useState } from 'react';
import { hexToBin, binToHex, secp256k1, generatePrivateKey } from '@bitauth/libauth';
import { rally } from '../chain';
import { signPresence, parsePresenceCode } from '../lib/tx.js';
import { tr, qrImage } from '../shared';

/** Scan one QR with the camera. Only where the browser has BarcodeDetector; everyone can still paste the code. */
export function ScanQR({ onCode }: { onCode: (code: string) => void }) {
  const [on, setOn] = useState(false);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!on || !video) return;
    let stop = false;
    let stream: MediaStream | undefined;
    const Detector = (window as unknown as { BarcodeDetector: new (o: object) => { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(async (s) => {
      stream = s;
      video.srcObject = s;
      await video.play();
      while (!stop) {
        const [code] = await detector.detect(video).catch(() => []);
        if (code) { onCode(code.rawValue.trim()); setOn(false); return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }).catch(() => setOn(false));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [on, video, onCode]);
  if (!('BarcodeDetector' in window)) return null;
  return on ? <video ref={setVideo} className="scan" muted playsInline /> : <button className="ghost" onClick={() => setOn(true)}>📷 {tr('Scan QR', 'Pindai QR')}</button>;
}

/** #/device/<stall id>: the stall's phone. Holds the stall's presence key and signs each buyer's code. */
export function Device() {
  const id = Number(location.hash.match(/^#\/device\/(\d+)/)?.[1] ?? 0);
  const m = rally.merchants.find((x) => x.id === id);
  const [key, setKey] = useState(() => {
    let k: string | null = null;
    try { k = localStorage.getItem('jelajah-device-key'); } catch { /* private mode */ }
    if (!k) {
      k = binToHex(generatePrivateKey());
      try { localStorage.setItem('jelajah-device-key', k); } catch { /* the key then lives only in this tab */ }
    }
    return k;
  });
  const pub = binToHex(secp256k1.derivePublicKeyCompressed(hexToBin(key)) as Uint8Array);
  const [buyer, setBuyer] = useState('');
  const parsed = parsePresenceCode(buyer);
  const sig = m && parsed ? binToHex(signPresence(hexToBin(key), rally, m.id, parsed.buyerPkh, parsed.outpoint)) : null;
  return (
    <main className="poster device">
      <p className="eyebrow">{rally.name} · {tr('stall device', 'perangkat warung')}</p>
      <h1>{m ? `${m.emoji} ${m.name}` : tr('Stall device', 'Perangkat warung')}</h1>
      <p className="muted small">{tr("This device's presence key (give it to the organizer when the rally is set up):", 'Kunci presence perangkat ini (berikan ke penyelenggara saat rally dibuat):')}<br /><code className="wrap">{pub}</code></p>
      <details className="muted small">
        <summary>{tr('Back up or move this key', 'Backup atau pindahkan kunci ini')}</summary>
        <p>{tr('Secret key (keep it private; paste it on a new phone to take over this stall):', 'Kunci rahasia (jangan dibagikan; tempel di ponsel baru untuk mengambil alih warung ini):')}<br /><code className="wrap">{key}</code></p>
        <label>{tr('Use another key (64 hex characters):', 'Pakai kunci lain (64 karakter hex):')}
          <input className="code" placeholder="…" onChange={(e) => {
            const k = e.target.value.trim().toLowerCase();
            if (/^[0-9a-f]{64}$/.test(k) && secp256k1.validatePrivateKey(hexToBin(k))) {
              try { localStorage.setItem('jelajah-device-key', k); } catch { /* this tab only */ }
              setKey(k);
            }
          }} /></label>
      </details>
      {m && m.presenceKey !== pub && <p className="error">{tr("This device's key is not the one registered for this stall, so its codes won't work here.", 'Kunci perangkat ini bukan yang terdaftar untuk warung ini, jadi kodenya tidak akan berlaku.')}</p>}
      {m && (<>
        <p className="lede">{tr("Scan or paste the buyer's code, then let them scan the reply.", 'Pindai atau tempel kode pembeli, lalu biarkan mereka memindai balasannya.')}</p>
        <ScanQR onCode={(c) => setBuyer(c.toLowerCase())} />
        <input className="code" value={buyer} onChange={(e) => setBuyer(e.target.value.trim().toLowerCase())} placeholder={tr("buyer's code", 'kode pembeli')} />
        {buyer && !parsed && <p className="error">{tr("That isn't a Jelajah buyer code.", 'Itu bukan kode pembeli Jelajah.')}</p>}
        {sig && <><img className="qr" src={qrImage(sig)} alt={tr('Signed code for the buyer', 'Kode bertanda tangan untuk pembeli')} /><code className="wrap small">{sig}</code></>}
      </>)}
      {m && <p className="small"><a href={`#/till/${m.id}`}>🔔 {tr('Open this stall’s till', 'Buka kasir warung ini')}</a></p>}
      <p className="muted small">{tr('The code works once, for this buyer, at this stall, in this rally: a screenshot is useless to anyone else, and to them after they buy.', 'Kode ini berlaku sekali, untuk pembeli ini, di warung ini, di rally ini: screenshot tidak berguna bagi orang lain, dan bagi mereka setelah membeli.')}</p>
    </main>
  );
}
