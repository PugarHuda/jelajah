import type { Merchant } from './chain';

/** A rubber stamp. Inked when collected, a faint dashed outline when not. */
export function Stamp({ m, inked, size = 132 }: { m: Merchant; inked: boolean; size?: number }) {
  const ink = inked ? m.color : 'var(--faint)';
  const tilt = ((m.id * 37) % 21) - 10;
  const path = `stamp-ring-${m.id}`;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img"
      aria-label={`${m.name} stamp${inked ? ', collected' : ', not collected yet'}`}
      style={{ transform: `rotate(${inked ? tilt : 0}deg)`, transition: 'transform .4s' }}>
      <defs>
        <path id={path} d="M60,60 m-40,0 a40,40 0 1,1 80,0 a40,40 0 1,1 -80,0" />
        <filter id={`grain-${m.id}`}>
          <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed={m.id} />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.15" />
          <feComposite in="SourceGraphic" operator="in" />
        </filter>
      </defs>
      <g filter={inked ? `url(#grain-${m.id})` : undefined} opacity={inked ? 0.92 : 1}>
        <circle cx="60" cy="60" r="55" fill="none" stroke={ink} strokeWidth="3.5" strokeDasharray={inked ? undefined : '5 5'} />
        <circle cx="60" cy="60" r="31" fill="none" stroke={ink} strokeWidth="1.8" />
        <text fill={ink} fontSize="11" fontWeight="800" letterSpacing="2.2" fontFamily="var(--font-display)">
          <textPath href={`#${path}`} startOffset="50%" textAnchor="middle">
            {m.name.toUpperCase()} · JELAJAH · {m.name.toUpperCase()} ·
          </textPath>
        </text>
        <text x="60" y="71" textAnchor="middle" fontSize="30" opacity={inked ? 1 : 0.25}
          style={inked ? undefined : { filter: 'grayscale(1)' }}>{m.emoji}</text>
      </g>
    </svg>
  );
}

export function Trophy({ size = 120, name }: { size?: number; name: string }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={`${name} trophy`}>
      <circle cx="60" cy="60" r="56" fill="var(--gold-soft)" stroke="var(--gold)" strokeWidth="3" />
      <path d="M40 30h40v14a20 20 0 0 1-40 0z" fill="var(--gold)" />
      <path d="M40 34h-9a9 9 0 0 0 11 13M80 34h9a9 9 0 0 1-11 13" fill="none" stroke="var(--gold)" strokeWidth="3.5" />
      <rect x="55" y="63" width="10" height="14" fill="var(--gold)" />
      <rect x="44" y="77" width="32" height="8" rx="2" fill="var(--gold)" />
      <text x="60" y="100" textAnchor="middle" fontSize="8" fontWeight="800" fill="var(--ink)"
        textLength="72" lengthAdjust="spacingAndGlyphs" fontFamily="var(--font-display)">{name.toUpperCase()}</text>
    </svg>
  );
}
