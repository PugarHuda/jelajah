import { FailoverProvider } from './lib/failover';
import { rallyContracts, checkRallyConfig } from './lib/tx.js';

export interface Merchant { id: number; name: string; tagline: string; taglineId?: string; emoji: string; color: string; price: number; memberPrice?: number; lock: string; presenceKey?: string; place?: string }
export interface Rally {
  network: 'chipnet' | 'mainnet'; name: string; description: string; category: string; vmCategory: string;
  needed: number; reward: number; endTime: number; organizerPub: string; merchants: Merchant[]; genesisTx: string; minter?: 2 | 3 | 4; lanes?: number; levy?: number; bonusNeeded?: number; bonusReward?: number; streakDays?: number; streakReward?: number;
  sponsor?: { name: string; category: string; vmCategory: string; value: number; sponsorPub: string; endTime: number; genesisTx?: string };
}

// One rally file per network (written by scripts/rally.mjs). Mainnet wins when it exists;
// VITE_NETWORK=chipnet or ?net=chipnet forces the test rally.
// A rally opened on the organizer page travels in the link itself: still no server.
// ?r=<base64url of deflate-raw JSON> (short enough for a poster QR); ?rally=<base64url JSON> still works.
const rallies = import.meta.glob<{ default: Rally }>('./rally.*.json', { eager: true });
const params = new URLSearchParams(location.search);
const pick = params.get('net') ?? import.meta.env.VITE_NETWORK;
const byNet = (n: string) => rallies[`./rally.${n}.json`]?.default;

const toB64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pipe = async (b: Uint8Array, t: CompressionStream | DecompressionStream) =>
  new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(t)).arrayBuffer());
function decodeB64(b64: string | null) { try { return b64 ? new TextDecoder().decode(fromB64u(b64)) : null; } catch { return null; } }
async function inflate(b64: string) { try { return new TextDecoder().decode(await pipe(fromB64u(b64), new DecompressionStream('deflate-raw'))); } catch { return null; } }

export const rallyLink = async (r: Rally) =>
  `${location.origin}${location.pathname}?r=${toB64u(await pipe(new TextEncoder().encode(JSON.stringify(r)), new CompressionStream('deflate-raw')))}`;

// The link is untrusted input: keep only well-formed rallies, and only values that are safe to render and style.
export function parseRally(json: string | null): Rally | undefined {
  if (!json) return undefined;
  try {
    const r = JSON.parse(json) as Rally;
    const hex = (s: unknown, n: number) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
    const ok = (r.network === 'mainnet' || r.network === 'chipnet') && hex(r.category, 64) && hex(r.vmCategory, 64)
      && hex(r.genesisTx, 64) && hex(r.organizerPub, 66) && Array.isArray(r.merchants) && r.merchants.length > 0
      // payouts must be standard P2PKH or P2SH32 scripts
      && r.merchants.every((m) => Number.isInteger(m.id) && /^(76a914[0-9a-f]{40}88ac|aa20[0-9a-f]{64}87)$/.test(m.lock) && Number.isInteger(m.price))
      && [r.needed, r.reward, r.endTime].every(Number.isInteger) && [undefined, 2, 3, 4].includes(r.minter)
      && (r.sponsor === undefined || (r.minter === 3 && hex(r.sponsor.category, 64) && hex(r.sponsor.vmCategory, 64) && hex(r.sponsor.sponsorPub, 66)
        && Number.isInteger(r.sponsor.value) && Number.isInteger(r.sponsor.endTime) && r.merchants.every((m) => r.sponsor!.value < (m.memberPrice ?? m.price))))
      && ((r.minter ?? 1) < 3 || Number.isInteger(r.levy)) && (r.minter !== 4 || (Number.isInteger(r.streakDays) && (r.streakDays ?? 0) >= 2 && Number.isInteger(r.streakReward) && r.streakDays! * (r.levy! - 1000) - 1000 >= r.streakReward!)) && (r.bonusNeeded === undefined || (Number.isInteger(r.bonusNeeded) && Number.isInteger(r.bonusReward))) && (r.lanes === undefined || (Number.isInteger(r.lanes) && r.lanes >= 1 && r.lanes <= 8));
    if (!ok) return undefined;
    checkRallyConfig({ ...r, rewardsInPool: 1 }); // the same economic rules the CLI enforces (throws -> ignored below)
    if (r.sponsor) r.sponsor.name = String(r.sponsor.name ?? 'sponsor').slice(0, 40);
    r.merchants = r.merchants.map((m) => ({ ...m, color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#7a4a2b', name: String(m.name).slice(0, 40), emoji: String(m.emoji ?? '⭐').slice(0, 4), tagline: String(m.tagline ?? '').slice(0, 80), place: m.place === undefined ? undefined : String(m.place).slice(0, 80) }));
    return r;
  } catch { return undefined; }
}
// after the helpers above: they are consts, so using them earlier would hit the temporal dead zone
export const fromLink = parseRally(params.get('r') ? await inflate(params.get('r')!) : decodeB64(params.get('rally')));
// ?pp=<deflate-raw JSON>: a passport offer across two rallies (untrusted: shape-checked)
export interface Passport { network: 'chipnet' | 'mainnet'; name: string; category: string; vmCategory: string; reward: number; endTime: number; organizerPub: string; genesisTx: string;
  rallyA: { name: string; category: string; vmCategory: string }; rallyB: { name: string; category: string; vmCategory: string } }
export const passportFromLink = ((json: string | null): Passport | undefined => {
  try {
    if (!json) return undefined;
    const p = JSON.parse(json) as Passport;
    const hex = (s: unknown, n: number) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
    const side = (r: Passport['rallyA']) => !!r && hex(r.category, 64) && hex(r.vmCategory, 64);
    if (!((p.network === 'mainnet' || p.network === 'chipnet') && hex(p.category, 64) && hex(p.vmCategory, 64) && hex(p.organizerPub, 66) && hex(p.genesisTx, 64)
      && side(p.rallyA) && side(p.rallyB) && p.rallyA.category !== p.rallyB.category && Number.isInteger(p.reward) && Number.isInteger(p.endTime))) return undefined;
    return { ...p, name: String(p.name).slice(0, 60), rallyA: { ...p.rallyA, name: String(p.rallyA.name).slice(0, 40) }, rallyB: { ...p.rallyB, name: String(p.rallyB.name).slice(0, 40) } };
  } catch { return undefined; }
})(params.get('pp') ? await inflate(params.get('pp')!) : null);
// a passport link runs on its own network (the wallet and provider follow `rally.network`)
/** A rally from a ?r= payload (deflate-raw, base64url), shape- and rule-checked like a link. */
export const rallyFromPayload = async (r: string) => parseRally(await inflate(r));
// Every official rally on this network, the live one first, then retired ones kept in scripts/ (reputation spans all).
const archived = Object.values(import.meta.glob<{ default: Partial<Rally> }>('../scripts/rally.*.json', { eager: true })).map((m) => m.default)
  .filter((r): r is Rally => typeof r.category === 'string' && typeof r.network === 'string');
export const rally: Rally = fromLink ?? (passportFromLink ? byNet(passportFromLink.network) : undefined) ?? (pick ? byNet(pick) : undefined) ?? byNet('mainnet') ?? byNet('chipnet')!;
export const provider = new FailoverProvider(rally.network); // several Fulcrum servers, see lib/failover.ts
export const { minters, vault } = rallyContracts(rally, provider);
const live = byNet(rally.network); // not `rally`: that may be a community rally opened from a link
export const officialRallies: Rally[] = [...(live ? [live] : []), ...archived.filter((r) => r.network === rally.network && r.category !== live?.category)];
