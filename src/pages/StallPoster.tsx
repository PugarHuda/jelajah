import qrcode from 'qrcode-generator';
import { rally, type Merchant } from '../chain';
import { Stamp } from '../Stamp';
import { useState } from 'react';
import { tr, mapUrl, qrImage } from '../shared';

export function StallPoster({ m }: { m?: Merchant }) {
  const [nfc, setNfc] = useState<string | null>(null);
  if (!m) return <main><p>Unknown stall.</p></main>;
  const url = `${location.origin}${location.pathname}${location.search}#stall-${m.id}`; // keep ?r= for link rallies
  // Web NFC (Chrome on Android): write this stall's link to a cheap NFC sticker. Any phone that taps it opens the stall,
  // no app needed (phones read URL tags natively); the QR stays for everyone else.
  const writeTag = async () => {
    try {
      setNfc(tr('Hold an NFC sticker to the back of this phone…', 'Tempelkan stiker NFC ke belakang ponsel ini…'));
      await new (window as unknown as { NDEFReader: new () => { write(m: object): Promise<void> } }).NDEFReader().write({ records: [{ recordType: 'url', data: url }] });
      setNfc(tr('✅ Tag written: tapping it opens this stall.', '✅ Tag tertulis: menempelkan ponsel membuka warung ini.'));
    } catch (e) { setNfc(`✗ ${e instanceof Error ? e.message : String(e)}`); }
  };
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return (
    <main className="poster" style={{ '--c': m.color } as React.CSSProperties}>
      <p className="eyebrow">{rally.name} · stamp rally</p>
      <Stamp m={m} inked size={180} />
      <h1>{m.name}</h1>
      {m.place && <a className="place" href={mapUrl(m.place)} target="_blank" rel="noreferrer">📍 {m.place}</a>}
      <p className="lede">{tr(`Pay here with Bitcoin Cash and get the ${m.name} stamp. Collect ${rally.needed} → get a reward.`, `Bayar di sini pakai Bitcoin Cash dan dapat stamp ${m.name}. Kumpulkan ${rally.needed} → dapat hadiah.`)}</p>
      <img className="qr" src={qr.createDataURL(8, 16)} alt={tr(`QR code to ${m.name}'s stall in the rally`, `Kode QR ke warung ${m.name} di rally`)} />
      <p className="muted small">{url}</p>
      <p className="row no-print"><button className="primary" onClick={() => print()}>🖨 {tr('Print this poster (A4)', 'Cetak poster ini (A4)')}</button></p>
      {'NDEFReader' in window && <p className="row no-print"><button className="ghost" onClick={writeTag}>📶 {tr('Write this stall to an NFC tag', 'Tulis warung ini ke tag NFC')}</button></p>}
      {nfc && <p className="small no-print" role="status">{nfc}</p>}
      <p className="small no-print">{tr('For the stall:', 'Untuk warung:')} <a href={`#/till/${m.id}`}>🔔 {tr('open the till (rings on every sale)', 'buka kasir (berbunyi tiap ada penjualan)')}</a></p>
      <p className="small no-print">📄 <a href={`${import.meta.env.BASE_URL}stall-guide.pdf`} target="_blank" rel="noreferrer">{tr('One-page guide for stall owners (PDF)', 'Panduan satu halaman untuk pemilik warung (PDF)')}</a></p>
      <details className="no-print"><summary className="small">{tr('Till QR for the stall’s phone (keep it off the printed poster)', 'QR kasir untuk HP warung (jangan ikut dicetak)')}</summary>
        <img className="qr" src={qrImage(url.replace(`#stall-${m.id}`, `#/till/${m.id}`))} alt={tr('QR code to this stall’s till', 'Kode QR ke kasir warung ini')} /></details>
      <img className="poster-logo" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="Jelajah" width={56} height={56} />
      <a className="no-print" href="#">{tr('← Back to the rally', '← Kembali ke rally')}</a>
    </main>
  );
}
