// Electrum with failover: cashscript's provider talks to one server, so one server down would blank the whole app.
// This wraps it: a call that can't reach its server (refused, closed, timed out) moves on to the next public Fulcrum server
// and retries; an answer from a server (e.g. "transaction rejected") is passed through untouched.
// Servers checked live on 22 Nov 2026 (server.version over wss, port 50004).
import { ElectrumNetworkProvider, type NetworkProvider } from 'cashscript';
type Utxos = Awaited<ReturnType<NetworkProvider['getUtxos']>>;

export const SERVERS: Record<'mainnet' | 'chipnet', string[]> = {
  mainnet: ['bch.imaginary.cash', 'electrum.imaginary.cash', 'bch.loping.net', 'fulcrum.greyh.at', 'cashnode.bch.ninja', 'bch.soul-dev.com'],
  chipnet: ['chipnet.bch.ninja', 'chipnet.imaginary.cash'],
};
const UNREACHABLE = /connect|closed|socket|timed out|timeout|disconnect|unavailable|network|offline|abort/i;
const READ_TIMEOUT = 12_000;

const timeout = <T>(p: Promise<T>, ms: number) => new Promise<T>((ok, fail) => {
  const t = setTimeout(() => fail(new Error(`electrum request timed out after ${ms} ms`)), ms);
  p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); fail(e); });
});

export class FailoverProvider implements NetworkProvider {
  private i = 0;
  private inner: ElectrumNetworkProvider;
  readonly network: 'mainnet' | 'chipnet';
  private readonly hosts: string[];
  constructor(network: 'mainnet' | 'chipnet', hosts = SERVERS[network]) {
    this.network = network;
    this.hosts = hosts;
    this.inner = this.open();
  }
  /** the server currently in use (shown on the stats page) */
  get host() { return this.hosts[this.i]; }
  private open() { return new ElectrumNetworkProvider(this.network, { hostname: this.hosts[this.i] }); }
  private next(failed: ElectrumNetworkProvider) {
    if (this.inner !== failed) return; // a parallel call already moved on
    failed.disconnect().catch(() => {});
    this.i = (this.i + 1) % this.hosts.length;
    this.inner = this.open();
  }
  private async run<T>(call: (p: ElectrumNetworkProvider) => Promise<T>, read = true): Promise<T> {
    let last: unknown;
    for (let n = 0; n < this.hosts.length; n++) {
      const p = this.inner;
      try { return await (read ? timeout(call(p), READ_TIMEOUT) : call(p)); } catch (e) {
        if (!UNREACHABLE.test(e instanceof Error ? e.message : String(e))) throw e; // the server answered: not ours to retry
        last = e;
        this.next(p);
      }
    }
    throw last;
  }
  getUtxos(address: string): Promise<Utxos> { return this.run((p) => p.getUtxos(address)); }
  getUtxosForLockingBytecode(bytecode: Uint8Array | string): Promise<Utxos> { return this.run((p) => p.getUtxosForLockingBytecode(bytecode)); }
  getBlockHeight(): Promise<number> { return this.run((p) => p.getBlockHeight()); }
  getRawTransaction(txid: string): Promise<string> { return this.run((p) => p.getRawTransaction(txid)); }
  // no timeout retry on a broadcast: it may have gone through; only a refused connection moves on
  sendRawTransaction(txHex: string): Promise<string> { return this.run((p) => p.sendRawTransaction(txHex), false); }
  performRequest(name: string, ...params: unknown[]): Promise<unknown> { return this.run((p) => p.performRequest(name, ...(params as never[]))); }
  connect() { return this.inner.connect(); }
  disconnect() { return this.inner.disconnect(); }
}
