// Independent Jelajah ID verifier: give it a Nostr key (npub or hex) or a BCH address. It reads only public relays and
// the BCH chain, checks both keys' proofs, and prints the verified link. No Jelajah server or database is involved.
//   node scripts/verify-identity.mjs npub1…            node scripts/verify-identity.mjs bitcoincash:q…   [--network chipnet]
import { parseArgs } from 'node:util';
import { ElectrumNetworkProvider } from 'cashscript';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { findLinks, verifyLink } from '../src/lib/identity.js';

const { positionals: [who], values: { network } } = parseArgs({ allowPositionals: true, options: { network: { type: 'string', default: 'mainnet' } } });
if (!who) throw new Error('usage: verify-identity.mjs <npub|hex nostr key|bch address> [--network mainnet|chipnet]');
const query = who.includes(':') ? { address: who }
  : { nostrPubkey: who.startsWith('npub') ? nip19.decode(who).data : who };
const pool = new SimplePool();
const provider = new ElectrumNetworkProvider(network);
const events = await findLinks(pool, query);
console.log(`${events.length} link event(s) found on public relays`);
for (const ev of events) {
  const r = await verifyLink(ev, provider);
  console.log(r.ok
    ? `VERIFIED  nostr ${nip19.npubEncode(r.nostrPubkey)}  <->  ${r.address}  (BCH proof ${r.txid})`
    : `rejected  ${ev.id.slice(0, 12)}…: ${r.reason}`);
}
pool.close?.([]);
process.exit(0);
