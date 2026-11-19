import { ElectrumNetworkProvider } from 'cashscript';
import { rallyContracts } from './lib/tx.js';

export interface Merchant { id: number; name: string; tagline: string; taglineId?: string; emoji: string; color: string; price: number; memberPrice?: number; lock: string }
export interface Rally {
  network: 'chipnet' | 'mainnet'; name: string; description: string; category: string; vmCategory: string;
  needed: number; reward: number; endTime: number; organizerPub: string; merchants: Merchant[]; genesisTx: string; minter?: 2 | 3; lanes?: number; levy?: number;
}

// One rally file per network (written by scripts/rally.mjs). Mainnet wins when it exists;
// VITE_NETWORK=chipnet or ?net=chipnet forces the test rally.
// A rally opened on the organizer page travels in the link itself (?rally=<base64url JSON>): still no server.
const rallies = import.meta.glob<{ default: Rally }>('./rally.*.json', { eager: true });
const params = new URLSearchParams(location.search);
const pick = params.get('net') ?? import.meta.env.VITE_NETWORK;
const byNet = (n: string) => rallies[`./rally.${n}.json`]?.default;
export const fromLink = rallyFromLink(params.get('rally'));
export const rally: Rally = fromLink ?? (pick ? byNet(pick) : undefined) ?? byNet('mainnet') ?? byNet('chipnet')!;

export const rallyLink = (r: Rally) => {
  const bytes = new TextEncoder().encode(JSON.stringify(r));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}?rally=${b64}`;
};

// The link is untrusted input: keep only well-formed rallies, and only values that are safe to render and style.
function rallyFromLink(b64: string | null): Rally | undefined {
  if (!b64) return undefined;
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const r = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Rally;
    const hex = (s: unknown, n: number) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
    const ok = (r.network === 'mainnet' || r.network === 'chipnet') && hex(r.category, 64) && hex(r.vmCategory, 64)
      && hex(r.genesisTx, 64) && hex(r.organizerPub, 66) && Array.isArray(r.merchants) && r.merchants.length > 0
      && r.merchants.every((m) => Number.isInteger(m.id) && m.id >= 1 && m.id <= 127 && /^[0-9a-f]+$/.test(m.lock) && m.price > 0)
      && [r.needed, r.reward, r.endTime].every(Number.isInteger) && [undefined, 2, 3].includes(r.minter);
    if (!ok) return undefined;
    r.merchants = r.merchants.map((m) => ({ ...m, color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#7a4a2b', name: String(m.name).slice(0, 40), emoji: String(m.emoji ?? '⭐').slice(0, 4), tagline: String(m.tagline ?? '').slice(0, 80) }));
    return r;
  } catch { return undefined; }
}
export const provider = new ElectrumNetworkProvider(rally.network);
export const { minters, vault } = rallyContracts(rally, provider);
