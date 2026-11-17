import { ElectrumNetworkProvider } from 'cashscript';
import { rallyContracts } from './lib/tx.js';

export interface Merchant { id: number; name: string; tagline: string; emoji: string; color: string; price: number; lock: string }
export interface Rally {
  network: 'chipnet' | 'mainnet'; name: string; description: string; category: string; vmCategory: string;
  needed: number; reward: number; endTime: number; organizerPub: string; merchants: Merchant[]; genesisTx: string;
}

// One rally file per network (written by scripts/rally.mjs). Mainnet wins when it exists;
// VITE_NETWORK=chipnet or ?net=chipnet forces the test rally.
const rallies = import.meta.glob<{ default: Rally }>('./rally.*.json', { eager: true });
const pick = new URLSearchParams(location.search).get('net') ?? import.meta.env.VITE_NETWORK;
const byNet = (n: string) => rallies[`./rally.${n}.json`]?.default;
export const rally: Rally = (pick ? byNet(pick) : undefined) ?? byNet('mainnet') ?? byNet('chipnet')!;
export const provider = new ElectrumNetworkProvider(rally.network);
export const { minters, vault } = rallyContracts(rally, provider);
