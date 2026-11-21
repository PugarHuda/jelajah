import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, Sequence, getStaticFiles, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { loadFont as loadDisplay } from '@remotion/google-fonts/Fraunces';
import { loadFont as loadBody } from '@remotion/google-fonts/Inter';
import type { ReactNode } from 'react';

export const FPS = 30;
const display = loadDisplay('normal', { weights: ['800'] }).fontFamily;
const body = loadBody('normal', { weights: ['500', '700'] }).fontFamily;
const C = { paper: '#f5eedf', card: '#fffaf0', ink: '#2a1d14', muted: '#6f5e50', accent: '#b3261e', gold: '#b7791f', line: '#e4d7c3', ok: '#15803d' };

// a scene: either a title card or a screen capture of the live app with a caption
type Scene = { s: number; render: () => ReactNode };
const clip = (name: string, s: number, kicker: string, caption: ReactNode, from = 0, rate = 1.15): Scene =>
  ({ s, render: () => <Capture src={`clips/${name}`} from={from} rate={rate} kicker={kicker} caption={caption} /> });

// the user's own phone clip (a real purchase in Selene/Paytaca) goes in if video/public/clips/phone.mp4 exists
const hasPhone = getStaticFiles().some((f) => f.name === 'clips/phone.mp4');

const SCENES: Scene[] = [
  { s: 4.5, render: () => <Intro /> },
  { s: 5.5, render: () => <Problem /> },
  clip('home.webm', 11, 'Live on BCH mainnet', <>Pay a warung. Its stamp NFT is printed <em>in the same transaction</em>.</>, 0.5),
  ...(hasPhone ? [{ s: 10, render: () => <Phone /> }] : []),
  clip('story.webm', 12.5, 'The rally', <>Stamps from 3 <em>different</em> stalls → a reward and a trophy that works as a member card.</>, 0.3, 1.25),
  { s: 7, render: () => <Levy /> },
  clip('till.webm', 5, 'For the stall', <>The till rings the moment a stamp is paid.</>, 0.5, 1),
  clip('stats.webm', 6, 'Nothing to fake', <>Every number is recomputed from the chain, across every season.</>, 8, 1),
  clip('organize.webm', 7, 'Anyone can run one', <>Open a rally from the browser. The contract rules are checked before your wallet signs.</>, 0.4, 1.2),
  { s: 8, render: () => <Proof /> },
  { s: 6.5, render: () => <Outro /> },
];
const frames = (s: number) => Math.round(s * FPS);
export const totalFrames = () => SCENES.reduce((n, x) => n + frames(x.s), 0);

export const Jelajah = () => {
  let at = 0;
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: body, color: C.ink }}>
      {SCENES.map((x, i) => {
        const from = at;
        at += frames(x.s);
        return <Sequence key={i} from={from} durationInFrames={frames(x.s)}><Fade>{x.render()}</Fade></Sequence>;
      })}
    </AbsoluteFill>
  );
};

// fade every scene in and out
const Fade = ({ children }: { children: ReactNode }) => {
  const f = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const o = interpolate(f, [0, 8, durationInFrames - 8, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};
const rise = (f: number, fps: number, delay = 0) => spring({ frame: f - delay, fps, config: { damping: 200 } });

const Kicker = ({ children, color = C.accent }: { children: ReactNode; color?: string }) => (
  <div style={{ textTransform: 'uppercase', letterSpacing: '0.16em', fontWeight: 700, fontSize: 26, color }}>{children}</div>
);
const H = ({ children, size = 88 }: { children: ReactNode; size?: number }) => (
  <div style={{ fontFamily: display, fontWeight: 800, fontSize: size, lineHeight: 1.05 }}>{children}</div>
);

const Intro = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = rise(f, fps);
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 28 }}>
      <Img src={staticFile('logo.svg')} style={{ width: 220, transform: `scale(${0.6 + 0.4 * k}) rotate(${(1 - k) * -40}deg)` }} />
      <H size={150}>Jelajah</H>
      <div style={{ opacity: rise(f, fps, 12), fontSize: 44, color: C.muted }}>A stamp rally on <b style={{ color: C.accent }}>Bitcoin Cash</b></div>
    </AbsoluteFill>
  );
};

const Problem = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ padding: '0 160px', justifyContent: 'center', gap: 34 }}>
      <Kicker>Stamp cards today</Kicker>
      <H>Paper stamps are easy to fake.</H>
      <div style={{ opacity: rise(f, fps, 30) }}><H>The prize depends on <span style={{ color: C.accent }}>a promise.</span></H></div>
      <div style={{ opacity: rise(f, fps, 70), fontSize: 40, color: C.muted, maxWidth: 1300 }}>
        Jelajah puts the card on chain: every stamp is a real, paid visit, and the prize sits in a covenant.
      </div>
    </AbsoluteFill>
  );
};

// a screen capture in a browser frame, with a caption bar
const Capture = ({ src, from, rate, kicker, caption }: { src: string; from: number; rate: number; kicker: string; caption: ReactNode }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const zoom = interpolate(f, [0, 10 * fps], [1, 1.04], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', paddingTop: 46 }}>
      <div style={{ width: 1380, borderRadius: 22, overflow: 'hidden', border: `3px solid ${C.ink}`, boxShadow: `14px 14px 0 ${C.line}`, background: C.card, transform: `scale(${zoom})`, transformOrigin: 'top center' }}>
        <div style={{ height: 42, background: C.ink, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px' }}>
          {['#e5534b', '#e0a53a', '#4bb55a'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: 99, background: c }} />)}
          <span style={{ marginLeft: 18, color: '#d9cbb6', fontSize: 19 }}>jelajah-bch.vercel.app</span>
        </div>
        <OffthreadVideo src={staticFile(src)} startFrom={Math.round(from * fps)} playbackRate={rate} muted style={{ width: 1380, display: 'block' }} />
      </div>
      <div style={{ position: 'absolute', left: 120, right: 120, bottom: 56, background: C.ink, color: C.paper, borderRadius: 22, padding: '26px 40px', transform: `translateY(${(1 - rise(f, fps, 6)) * 40}px)`, opacity: rise(f, fps, 6) }}>
        <Kicker color="#f0b27a">{kicker}</Kicker>
        <div style={{ fontFamily: display, fontWeight: 800, fontSize: 50, lineHeight: 1.15, marginTop: 8 }}>{caption}</div>
      </div>
    </AbsoluteFill>
  );
};

const Phone = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 60, flexDirection: 'row' }}>
    <OffthreadVideo src={staticFile('clips/phone.mp4')} muted style={{ height: 900, borderRadius: 40, border: `6px solid ${C.ink}` }} />
    <div style={{ maxWidth: 640 }}><Kicker>A real purchase</Kicker><H size={70}>One wallet prompt. The stamp lands in the same transaction.</H></div>
  </AbsoluteFill>
);

const Levy = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const box = (label: string, value: string, color: string, d: number) => (
    <div style={{ opacity: rise(f, fps, d), transform: `translateY(${(1 - rise(f, fps, d)) * 30}px)`, background: C.card, border: `3px solid ${color}`, borderRadius: 24, padding: '30px 40px', width: 440 }}>
      <div style={{ fontSize: 30, color: C.muted }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 72, color }}>{value}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ padding: '0 160px', justifyContent: 'center', gap: 40 }}>
      <Kicker>“What if the stalls collude?”</Kicker>
      <div style={{ display: 'flex', gap: 34, alignItems: 'center' }}>
        {box('to the stall', '1,500', C.ink, 10)}
        <div style={{ fontSize: 70, opacity: rise(f, fps, 20) }}>+</div>
        {box('levy into the prize pool', '2,500', C.accent, 30)}
      </div>
      <div style={{ opacity: rise(f, fps, 60) }}><H size={64}>Each set's own levies pay its reward. Colluding stalls only pay themselves.</H></div>
    </AbsoluteFill>
  );
};

const PROOFS: [string, string][] = [
  ['Levy rally genesis', 'e0ed3240…'],
  ['XO: buy → claim, same covenants', '70efa57c…'],
  ['FoldingCash claim, rotated root', 'aebb5f33…'],
  ['SolidCash StampCard redeem', '8d122760…'],
  ['Jelajah ID proof (BCH ↔ Nostr)', 'e9137c1c…'],
];
const Proof = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ padding: '0 160px', justifyContent: 'center', gap: 26 }}>
      <Kicker>All on BCH mainnet</Kicker>
      <H size={76}>Built solo from Jogja in 8 days.</H>
      <div style={{ marginTop: 16, display: 'grid', gap: 16 }}>
        {PROOFS.map(([what, tx], i) => (
          <div key={tx} style={{ opacity: rise(f, fps, 14 + i * 9), display: 'flex', justifyContent: 'space-between', fontSize: 38, borderBottom: `2px dashed ${C.line}`, paddingBottom: 12 }}>
            <span>✓ {what}</span><code style={{ color: C.ok, fontWeight: 700 }}>{tx}</code>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const Outro = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 30, textAlign: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 30 }}>
        <Img src={staticFile('logo.svg')} style={{ width: 150 }} /><H size={120}>Jelajah</H>
      </div>
      <div style={{ fontSize: 54, fontWeight: 700, color: C.accent, opacity: rise(f, fps, 8) }}>jelajah-bch.vercel.app</div>
      <div style={{ fontSize: 34, color: C.muted, opacity: rise(f, fps, 18) }}>Try a set with Selene or Paytaca · dorahacks.io/buidl/51463 · #BCHBLAZE2026</div>
      <Img src={staticFile('stamps.png')} style={{ width: 760, marginTop: 10, opacity: rise(f, fps, 26) }} />
    </AbsoluteFill>
  );
};
