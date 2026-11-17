import { ElectrumNetworkProvider } from 'cashscript';
import rallyJson from './rally.json';
import { rallyContracts } from './lib/tx.js';

export interface Merchant { id: number; name: string; tagline: string; emoji: string; color: string; price: number; lock: string }
export interface Rally {
  network: 'chipnet' | 'mainnet'; name: string; description: string; category: string; vmCategory: string;
  needed: number; reward: number; endTime: number; organizerPub: string; merchants: Merchant[]; genesisTx: string;
}

export const rally = rallyJson as Rally;
export const provider = new ElectrumNetworkProvider(rally.network);
export const { minters, vault } = rallyContracts(rally, provider);
