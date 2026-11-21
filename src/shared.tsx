import qrcode from 'qrcode-generator';
import { hexToBin, binToHex } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey, finalizeEvent, type NostrEvent } from 'nostr-tools/pure';
import { rally, type Merchant, type Rally } from './chain';
import { explorerTx, addressOf, type Coin } from './wallet';

// ponytail: one clock reading per page load; every route change here reloads the page anyway
export const LOADED_AT = Date.now() / 1000;
export const sats = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} sats`;

// Rupiah hint next to sat prices. One public price lookup, nothing about the user is sent; no rate -> no hint.
export let idrPerBch: number | null = null;
export const idrRate = fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=idr')
  .then((r) => r.json()).then((j) => { idrPerBch = j['bitcoin-cash']?.idr ?? null; }).catch(() => {});
export const rupiah = (n: number | bigint) => idrPerBch === null ? ''
  : ` ≈ Rp${Math.round(Number(n) / 1e8 * idrPerBch).toLocaleString('id-ID')}`;

// UI language: ?lang=id|en, then the saved choice, then the browser. ponytail: inline pairs, no i18n lib for two languages.
export const ID = (() => {
  let saved: string | null = null;
  try { saved = localStorage.getItem('lang'); } catch { /* private mode */ }
  const l = new URLSearchParams(location.search).get('lang') ?? saved ?? navigator.language;
  return l.toLowerCase().startsWith('id');
})();
document.documentElement.lang = ID ? 'id' : 'en';
export const tr = (en: string, id: string) => (ID ? id : en);
export function switchLang() {
  try { localStorage.setItem('lang', ID ? 'en' : 'id'); } catch { /* private mode */ }
  const u = new URL(location.href);
  u.searchParams.set('lang', ID ? 'en' : 'id');
  location.href = u.href;
  if (u.hash) setTimeout(() => location.reload());
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
export const shareUrl = (label: string, txid: string) => `https://x.com/intent/post?text=${encodeURIComponent(`${label} on ${rally.name}, a stamp rally on Bitcoin Cash. On chain: ${explorerTx(txid)}\n\n${location.origin}${location.pathname} #BCHBLAZE2026`)}`;
export const qrImage = (text: string) => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createDataURL(6, 8); };

export const back = <p><a href="#" onClick={() => setTimeout(() => location.reload())}>{tr('← Back to the rally', '← Kembali ke rally')}</a></p>;

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
