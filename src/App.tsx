import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWizardConnect, WizardConnectQRDialog } from '@wizardconnect/react';
import qrcode from 'qrcode-generator';
import { rally, provider, minters, vault, type Merchant } from './chain';
import { buildStamp, buildClaim, isRallyNft } from './lib/tx.js';
import { buyerLock, walletCoins, signAndSend, explorerTx, addressOf, type Coin } from './wallet';
import { Stamp, Trophy } from './Stamp';
import { SLIDES_URL, REPO_URL, VOTE_ADDRESS } from './links';

const sats = (n: number | bigint) => `${Number(n).toLocaleString('en-US')} sats`;
const stallOf = (c: Coin) => parseInt(c.utxo.token!.nft!.commitment.slice(0, 2), 16);

export default function App() {
  const stallFromHash = window.location.hash.match(/^#\/stall\/(\d+)/)?.[1];
  if (stallFromHash) return <StallPoster m={rally.merchants.find((x) => x.id === Number(stallFromHash))} />;
  return <Rally />;
}

function Rally() {
  const wc = useWizardConnect({ dappName: 'Jelajah', dappIcon: `${location.origin}/favicon.svg` });
  const [coins, setCoins] = useState<Coin[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<{ label: string; txid: string }[]>([]);
  const [pool, setPool] = useState<bigint | null>(null);
  const connected = wc.state === 'connected' && wc.manager;

  const refresh = useCallback(async () => {
    vault.getUtxos().then((u) => setPool(u[0]?.satoshis ?? 0n)).catch(() => {});
    if (connected) setCoins(await walletCoins(wc.manager!));
  }, [connected, wc.manager]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 12_000);
    return () => clearInterval(t);
  }, [refresh]);

  const nfts = coins.filter((c) => isRallyNft(rally, c.utxo));
  const lock = connected ? buyerLock(wc.manager!) : null;
  const mine = (c: Coin) => lock && c.utxo.token!.nft!.commitment.slice(2) === hex(lock.slice(3, 23));
  const stamps = nfts.filter((c) => stallOf(c) > 0 && mine(c));
  const trophies = nfts.filter((c) => stallOf(c) === 0);
  const collected = useMemo(() => new Set(stamps.map(stallOf)), [stamps]);
  const bch = coins.filter((c) => !c.utxo.token).reduce((s, c) => s + c.utxo.satoshis, 0n);
  const ready = collected.size >= rally.needed;
  const rewardsLeft = pool === null ? null : Number((pool - 1000n) / BigInt(rally.reward)); // vault keeps 1000 sats dust

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label); setError(null);
    try {
      const txid = await fn();
      setLog((l) => [{ label, txid }, ...l]);
      setTimeout(refresh, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  }

  const buy = (m: Merchant) => run(`${m.emoji} Stamped at ${m.name}`, async () => {
    const { builder, inputs } = await buildStamp({ rally, provider, minters, merchantId: m.id, buyerLock: lock!, coins });
    return signAndSend(wc.manager!, builder, inputs, `Pay ${m.name} ${sats(m.price)} and get its Jelajah stamp`);
  });

  const claim = () => run('🏆 Set claimed: reward + trophy', async () => {
    const { builder, inputs } = await buildClaim({
      rally, provider, vault, buyerLock: lock!, stamps, coins: coins.filter((c) => !c.utxo.token),
    });
    return signAndSend(wc.manager!, builder, inputs, `Burn ${rally.needed} stamps for ${sats(rally.reward)} + a trophy`);
  });

  return (
    <>
      <Banner />
      <header className="top">
        <a className="brand" href="#"><span className="brand-mark">◉</span> Jelajah</a>
        <span className={`pill ${rally.network}`}>{rally.network === 'mainnet' ? 'BCH mainnet' : 'chipnet (test)'}</span>
        <div className="grow" />
        {connected ? (
          <button className="ghost" onClick={wc.disconnect} title="Disconnect">
            {wc.walletName ?? 'Wallet'} · {sats(bch)}
          </button>
        ) : (
          <button className="primary" onClick={wc.connect} disabled={wc.state === 'connecting'}>
            {wc.state === 'connecting' ? 'Waiting for wallet…' : 'Connect wallet'}
          </button>
        )}
      </header>
      {wc.uri && wc.qrUri && (
        <WizardConnectQRDialog show={wc.state === 'connecting'} onClose={wc.disconnect} uri={wc.uri} qrUri={wc.qrUri}
          title="Connect with WizardConnect" subtitle="Scan with Selene or Paytaca" />
      )}

      <main>
        <section className="hero">
          <p className="eyebrow">{rally.name} · a stamp rally on Bitcoin Cash</p>
          <h1>Eat at {rally.needed} stalls.<br />Collect {rally.needed} stamps.<br /><em>Get paid back.</em></h1>
          <p className="lede">
            Paying a stall prints its stamp NFT <b>in the same transaction</b>. Burn a full set and the rally's
            contract pays you {sats(rally.reward)} and mints your trophy. No sign-up, no server, no one holding the prize money.
          </p>
        </section>

        <section className="board" aria-label="Stalls">
          <div className="board-head">
            <div>
              <h2>Stalls</h2>
              <p className="muted">Any {rally.needed} different stalls complete the set.</p>
            </div>
            <div className="progress" aria-live="polite">
              <b>{Math.min(collected.size, rally.needed)}</b>/{rally.needed}
              <span className="muted"> stamps</span>
            </div>
          </div>
          <div className="stalls">
            {rally.merchants.map((m) => {
              const have = collected.has(m.id);
              return (
                <article key={m.id} id={`stall-${m.id}`} className={`stall ${have ? 'have' : ''}`} style={{ '--c': m.color } as React.CSSProperties}>
                  <Stamp m={m} inked={have} />
                  <h3>{m.name}</h3>
                  <p className="muted small">{m.tagline}</p>
                  <button className={have ? 'ghost' : 'primary'} disabled={!connected || !!busy}
                    onClick={() => buy(m)} title={connected ? undefined : 'Connect your wallet first'}>
                    {busy === `${m.emoji} Stamped at ${m.name}` ? 'Approve in wallet…' : have ? `Buy again · ${sats(m.price)}` : `Buy & stamp · ${sats(m.price)}`}
                  </button>
                </article>
              );
            })}
          </div>

          <div className={`claim ${ready ? 'ready' : ''}`}>
            <div>
              <h3>{ready ? 'Your set is complete' : 'Complete the set'}</h3>
              <p className="muted small">
                Burns one stamp from each of {rally.needed} stalls → {sats(rally.reward)} + a {rally.name} Trophy NFT.
                {rewardsLeft !== null && ` ${Math.max(rewardsLeft, 0)} rewards left in the pool.`}
              </p>
            </div>
            <button className="primary big" disabled={!ready || !!busy} onClick={claim}>
              {busy?.startsWith('🏆') ? 'Approve in wallet…' : `Claim ${sats(rally.reward)} + trophy`}
            </button>
          </div>
          {!connected && <p className="hint">Connect a wallet (Selene, Paytaca, Cashonize) to start. Each stamp costs the stall's price plus a tiny network fee.</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        {trophies.length > 0 && (
          <section className="shelf">
            <h2>Trophy shelf</h2>
            <div className="trophies">{trophies.map((t) => <Trophy key={t.utxo.txid} name={rally.name} />)}</div>
          </section>
        )}

        {log.length > 0 && (
          <section className="log">
            <h2>Your transactions</h2>
            <ul>{log.map((l) => <li key={l.txid}>{l.label} · <a href={explorerTx(l.txid)} target="_blank" rel="noreferrer">{l.txid.slice(0, 12)}…</a></li>)}</ul>
          </section>
        )}

        <section className="how">
          <h2>How it works</h2>
          <ol>
            <li><b>Organizer</b> locks the reward pool in a covenant. It can't take it back before the rally ends.</li>
            <li><b>Every purchase</b> runs through the stall's covenant: it only lets the stamp out if the stall got paid at least its price. Stamps carry the buyer's key hash.</li>
            <li><b>The vault</b> loops over the stamps you burn: same category, {rally.needed} different stalls, all bought by you. Then it pays you and mints your trophy.</li>
          </ol>
          <p className="muted small">
            Anti-farming: the reward ({sats(rally.reward)}) is always lower than the cheapest full set, so a stall can't profit by buying from itself.
            Stamps can be traded as collectibles, but the reward always goes to whoever actually bought them.
          </p>
          <dl className="tech">
            <dt>Token category</dt><dd><code>{rally.category}</code></dd>
            <dt>Reward vault</dt><dd><code>{vault.tokenAddress}</code></dd>
            <dt>Genesis</dt><dd><a href={explorerTx(rally.genesisTx)} target="_blank" rel="noreferrer">{rally.genesisTx.slice(0, 16)}…</a></dd>
            <dt>Stall posters</dt><dd>{rally.merchants.map((m) => <a key={m.id} href={`#/stall/${m.id}`}>{m.emoji} {m.name}</a>)}</dd>
          </dl>
        </section>
      </main>
      <footer>Jelajah · stamp rallies on Bitcoin Cash · built for BCH BLAZE 2026 {lock && <span className="muted">· your stamp address {addressOf(lock, true)}</span>}</footer>
    </>
  );
}

function Banner() {
  return (
    <div className="banner">
      <b>BCH BLAZE 2026 entry</b>
      {SLIDES_URL && <a href={SLIDES_URL} target="_blank" rel="noreferrer">Slides</a>}
      {REPO_URL && <a href={REPO_URL} target="_blank" rel="noreferrer">Code</a>}
      {VOTE_ADDRESS && <span>Vote / donate: <code>{VOTE_ADDRESS}</code></span>}
      <span>Built from scratch during BLAZE (17–22 Nov 2026), no pre-existing code</span>
    </div>
  );
}

function StallPoster({ m }: { m?: Merchant }) {
  if (!m) return <main><p>Unknown stall.</p></main>;
  const url = `${location.origin}${location.pathname}#stall-${m.id}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return (
    <main className="poster" style={{ '--c': m.color } as React.CSSProperties}>
      <p className="eyebrow">{rally.name} · stamp rally</p>
      <Stamp m={m} inked size={180} />
      <h1>{m.name}</h1>
      <p className="lede">Pay here with Bitcoin Cash and get the {m.name} stamp. Collect {rally.needed} → get paid back.</p>
      <img className="qr" src={qr.createDataURL(8, 16)} alt={`QR code to ${m.name}'s stall in the rally`} />
      <p className="muted small">{url}</p>
      <a href="#" onClick={() => setTimeout(() => location.reload())}>← Back to the rally</a>
    </main>
  );
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
