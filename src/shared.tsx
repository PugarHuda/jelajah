import qrcode from 'qrcode-generator';
import { hexToBin, binToHex } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey, finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { rally, type Merchant, type Rally } from './chain';
import { explorerTx, addressOf, type Coin } from './wallet';

// ponytail: one clock reading per page load; every route change here reloads the page anyway
export const LOADED_AT = Date.now() / 1000;
export const sats = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} sats`;

// Rupiah hint next to sat prices. One public price lookup, nothing about the user is sent; no rate -> no hint.
// the rupiah hint: cached for 30 minutes per browser, and a stale rate beats none when CoinGecko rate-limits (its 429 has no CORS)
const RATE_KEY = 'jelajah.idr';
const cachedRate = (() => { try { return JSON.parse(localStorage.getItem(RATE_KEY) ?? 'null') as { idr: number; at: number } | null; } catch { return null; } })();
export let idrPerBch: number | null = cachedRate?.idr ?? null;
export const idrRate: Promise<void> = cachedRate && Date.now() - cachedRate.at < 30 * 60_000 ? Promise.resolve()
  : fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=idr')
    .then((r) => r.json()).then((j) => j['bitcoin-cash']?.idr)
    .catch(() => undefined)
    // second source when CoinGecko rate-limits or is down (CoinPaprika: CORS open, reachable from Indonesia, unlike Coinbase/Kraken)
    .then((idr) => typeof idr === 'number' ? idr : fetch('https://api.coinpaprika.com/v1/tickers/bch-bitcoin-cash?quotes=IDR').then((r) => r.json()).then((j) => Number(j.quotes?.IDR?.price)))
    .then((idr) => {
      if (typeof idr !== 'number' || !(idr > 0)) return;
      idrPerBch = idr;
      try { localStorage.setItem(RATE_KEY, JSON.stringify({ idr, at: Date.now() })); } catch { /* private mode: no cache */ }
    }).catch(() => {});
export const rupiah = (n: number | bigint) => idrPerBch === null ? ''
  : ` ≈ Rp${Math.round(Number(n) / 1e8 * idrPerBch).toLocaleString('id-ID')}`;

// UI language: ?lang=id|en, then the saved choice, else English (the judges' language; the ID button switches). ponytail: inline pairs, no i18n lib for two languages.
export const ID = (() => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('lang'); } catch { /* private mode */ }
  const l = new URLSearchParams(location.search).get('lang') ?? saved ?? 'en';
  return l.toLowerCase().startsWith('id');
})();
document.documentElement.lang = ID ? 'id' : 'en';
export const tr = (en: string, id: string) => (ID ? id : en);
export function switchLang() {
  try { localStorage.setItem('lang', ID ? 'en' : 'id'); } catch { /* private mode */ }
  const u = new URL(location.href);
  u.searchParams.set('lang', ID ? 'en' : 'id');
  location.href = u.href; // a new query string always loads the page again, hash or not
}
// what the buyer pays for one stamp: the stall's (member) price plus the levy that goes to the pool
export const cost = (m: Merchant, member: boolean, voucher = false) => (member ? m.memberPrice! : m.price) + (rally.levy ?? 0) - (voucher ? rally.sponsor!.value : 0);
export const stallOf = (c: Coin) => parseInt(c.utxo.token!.nft!.commitment.slice(0, 2), 16);

export const shortAddr = (pkh: string) => { const a = addressOf(hexToBin(`76a914${pkh}88ac`)); return `${a.slice(0, a.indexOf(':') + 7)}…${a.slice(-5)}`; };

// a stall's place opens in OpenStreetMap: coordinates as a pin, anything else as a search
export const mapUrl = (place: string) => {
  const ll = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(place);
  return ll ? `https://www.openstreetmap.org/?mlat=${ll[1]}&mlon=${ll[2]}#map=18/${ll[1]}/${ll[2]}` : `https://www.openstreetmap.org/search?query=${encodeURIComponent(place)}`;
};

// a receipt anyone can check: the post carries the tx link, so the claim proves itself (no server, no image to fake)
const shareText = (label: string, txid: string) => `${label} on ${rally.name}, a stamp rally on Bitcoin Cash. On chain: ${explorerTx(txid)}\n\n${location.origin}${location.pathname} #BCHBLAZE2026`;
export const shareUrl = (label: string, txid: string) => `https://x.com/intent/post?text=${encodeURIComponent(shareText(label, txid))}`;
/** On phones: the OS share sheet (WhatsApp, Telegram…) via the Web Share API; elsewhere the link opens the X composer. */
export const shareTx = (label: string, txid: string) => (e: { preventDefault: () => void }) => {
  if (!navigator.share) return; // no Web Share: let the link open X
  e.preventDefault();
  navigator.share({ title: rally.name, text: shareText(label, txid) }).catch(() => { /* the user closed the sheet */ });
};
export const qrImage = (text: string) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 8); };

export const back = <p><a href="#">{tr('← Back to the rally', '← Kembali ke rally')}</a></p>;

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const reclaimStoreKey = (r: Rally) => `jelajah-reclaim-${r.category}`;

export type NostrSigner = { pubkey: string; sign: (t: { kind: number; created_at: number; tags: string[][]; content: string }) => Promise<NostrEvent> };
export async function nostrSigner(): Promise<NostrSigner> {
  const ext = (window as unknown as { nostr?: { getPublicKey(): Promise<string>; signEvent(e: object): Promise<NostrEvent> } }).nostr;
  if (ext) return { pubkey: await ext.getPublicKey(), sign: (t) => ext.signEvent(t) }; // NIP-07 extension (Alby, nos2x…)
  let hexKey: string | null = null;
  try { hexKey = localStorage.getItem('jelajah-nostr-sk'); } catch { /* private mode */ }
  if (!hexKey) {
    hexKey = binToHex(generateSecretKey());
    try { localStorage.setItem('jelajah-nostr-sk', hexKey); } catch { /* this tab only */ }
  }
  const sk = hexToBin(hexKey);
  return { pubkey: getPublicKey(sk), sign: async (t) => finalizeEvent(t, sk) };
}

// WizardConnect pairing text. A phone can't scan its own screen, and no wallet documents a wiz: link handler,
// so on a touch screen the dependable same-phone path is: copy the link (the dialog's copy button), paste it in the wallet.
export const wcSubtitle = () => (matchMedia('(pointer: coarse)').matches
  ? tr('On this phone? Tap copy under the code, open Selene or Paytaca and paste it in its WizardConnect screen, then come back.', 'Di ponsel ini? Ketuk salin di bawah kode, buka Selene atau Paytaca dan tempel di layar WizardConnect-nya, lalu kembali ke sini.')
  : tr('Scan with Selene or Paytaca', 'Pindai dengan Selene atau Paytaca'));
