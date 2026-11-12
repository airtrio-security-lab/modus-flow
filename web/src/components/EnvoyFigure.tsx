import type { ReactNode } from 'react';
import { outfit, type Outfit, type OutfitCiv } from '../lib/envoy-outfits';

/**
 * «Путь Посла» (ADR-0032): an original SVG envoy — civilization × rank (lib/envoy-outfits.ts).
 * No head and no face: the headwear sits over a high collar with a shadow below it. Facing right,
 * feet at y = 0, about 34 units tall (44 with a standard). Programmatic drawing, not an illustration.
 *
 * `detail="map"` keeps what the owner asked for at map scale: I–II a plain silhouette, III–IV insignia,
 * V–VI ceremonial pieces, VII the ring of the Commonwealth. Movement (walk, cloak, bag) is CSS only and
 * stops under prefers-reduced-motion and the light mode (styles.css, `.env-*`).
 */
const INK = '#2d2a24';
const SHADOW = '#1f1b16';
const METAL = { none: '#8a6a44', bronze: '#a8743a', silver: '#c7ccd4', gold: '#d4a531' } as const;
/** The five civilizations on the Commonwealth's ring and medallion — equal segments, no first among them. */
const RING = ['#2f5d8a', '#6e2a3c', '#2f6f6a', '#8c2f2f', '#8a6a2a'];

export interface EnvoyFigureProps {
  civ: string | null | undefined;
  rank: number;
  /** Colour of the department's coat of arms (crest, banner). */
  crest?: string;
  detail?: 'map' | 'full';
  walking?: boolean;
  /** Accessible name; omitted → decorative (aria-hidden). */
  label?: string;
}

export function EnvoyFigure({ civ, rank, crest = '#2f5d8a', detail = 'full', walking = false, label }: EnvoyFigureProps) {
  const o = outfit(civ, rank);
  const full = detail === 'full';
  const metal = METAL[o.metal];
  const hemY = { knee: -7, ankle: -2.6, floor: -0.7, train: -0.5 }[o.length];
  const hemW = { knee: 5.6, ankle: 6.6, floor: 7.6, train: 8.2 }[o.length];
  const has = (p: Outfit['pieces'][number]) => o.pieces.includes(p);
  return (
    <g
      className={`env-fig env-r${o.rank} env-${o.civ}${walking ? ' is-walking' : ''}`}
      data-rank={o.rank}
      data-civ={o.civ}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label ? <title>{label}</title> : null}
      <ellipse cy="0.6" rx={hemW + 2} ry="2.2" fill={SHADOW} opacity="0.22" />
      {has('commonwealth-ring') ? <CommonwealthRing /> : null}
      {has('banner') ? <BackBanner color={crest} tall={false} /> : null}
      {has('commonwealth-standard') ? <BackBanner color="#f4efe2" tall /> : null}
      <Cloak o={o} hemY={hemY} full={full} />
      {o.length === 'knee' || o.length === 'ankle' ? <Legs o={o} hemY={hemY} /> : <Feet />}
      {has('satchel') ? <Satchel o={o} /> : null}
      <Garment o={o} hemY={hemY} hemW={hemW} crest={crest} full={full} />
      {has('belt') ? <Belt o={o} /> : null}
      {has('crest') && o.civ !== 'japan' ? <Crest color={crest} x={0.6} y={-21} /> : null}
      {has('crest') && o.civ === 'japan' ? <Mon color={crest} /> : null}
      {has('chain') ? <Chain full={full} /> : null}
      {has('insignia') && full ? <Insignia /> : null}
      {has('medallion') ? <Medallion /> : null}
      {has('seal') && full ? <Seal /> : null}
      <Collar o={o} />
      <Headwear o={o} />
      <FrontArm o={o} metal={metal} full={full} />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Body parts
// ---------------------------------------------------------------------------
function Legs({ o, hemY }: { o: Outfit; hemY: number }) {
  const boot = o.civ === 'japan' ? '#e9e2d0' : o.civ === 'russia' && o.rank >= 2 ? '#8c2f2f' : '#3b2f24';
  const trousers = o.civ === 'japan' ? o.cloth : '#4a3f33';
  return (
    <g>
      <g className="env-leg env-leg-b">
        <path d={`M-1.9,${hemY - 1} L-2.6,-1.4 L-0.4,-1.4 L0.1,${hemY - 1} Z`} fill={trousers} stroke={INK} strokeWidth="0.5" />
        <path d="M-3.2,-1.6 h3 v1.6 h-3.6 z" fill={boot} stroke={INK} strokeWidth="0.5" />
      </g>
      <g className="env-leg env-leg-f">
        <path d={`M0.1,${hemY - 1} L0.8,-1.4 L3,-1.4 L2.3,${hemY - 1} Z`} fill={trousers} stroke={INK} strokeWidth="0.5" />
        <path d="M0.6,-1.6 h3 l0.8,1.6 h-3.8 z" fill={boot} stroke={INK} strokeWidth="0.5" />
      </g>
    </g>
  );
}

function Feet() {
  return (
    <g>
      <path d="M-2.8,-0.9 h2.6 v0.9 h-3 z" fill="#3b2f24" />
      <path d="M1.2,-0.9 h2.6 l0.7,0.9 h-3.3 z" fill="#3b2f24" />
    </g>
  );
}

/** The cloak behind the body: grows in length, cut and material with the rank. */
function Cloak({ o, hemY, full }: { o: Outfit; hemY: number; full: boolean }) {
  const bottom = { travel: -10, fine: -8, long: -3.5, parade: -2.4, embroidered: -1.2, mantle: -0.4, ceremonial: -0.2 }[o.cloak];
  const back = { travel: -6.5, fine: -7.2, long: -8, parade: -8.6, embroidered: -9.2, mantle: -11, ceremonial: -14 }[o.cloak];
  const d = `M-1,-24.5 C-5,-23.5 -6.2,-18 ${back + 1},${bottom - 2} L${back},${bottom} L${-1.5},${Math.max(bottom, hemY)} L1.5,-22 Z`;
  const edge = `M${back},${bottom} L${-1.5},${Math.max(bottom, hemY)}`;
  return (
    <g className="env-cloak">
      <path d={d} fill={o.cloakCloth} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
      {o.cloak !== 'travel' ? <path d={edge} stroke={o.trim} strokeWidth={o.rank >= 5 ? 1.4 : 0.9} /> : null}
      {o.pieces.includes('fur') ? <Fur from={{ x: back, y: bottom }} to={{ x: -1.5, y: Math.max(bottom, hemY) }} spots={o.civ === 'camelot' || o.civ === 'russia'} /> : null}
      {o.pieces.includes('embroidery') && full ? <Ornament civ={o.civ} x0={back + 1.2} y={bottom - 2.4} x1={-2.5} /> : null}
      {o.cloak === 'travel' ? <path d={`M-4,-18 q-1.4,3 -1.8,6.5`} stroke={SHADOW} strokeWidth="0.5" opacity="0.45" fill="none" /> : null}
    </g>
  );
}

function Fur({ from, to, spots }: { from: { x: number; y: number }; to: { x: number; y: number }; spots: boolean }) {
  const n = 4;
  return (
    <g>
      <path d={`M${from.x},${from.y} L${to.x},${to.y}`} stroke="#f3eee4" strokeWidth="2.2" strokeLinecap="round" />
      {spots
        ? Array.from({ length: n }, (_, i) => {
            const k = (i + 0.5) / n;
            return <circle key={i} cx={from.x + (to.x - from.x) * k} cy={from.y + (to.y - from.y) * k - 0.2} r="0.35" fill={SHADOW} />;
          })
        : null}
    </g>
  );
}

/** The civilization's ornament along the hem of the cloak (rank V+, profile only — too fine for the map). */
function Ornament({ civ, x0, y, x1 }: { civ: OutfitCiv; x0: number; y: number; x1: number }) {
  const step = 2.1;
  const xs: number[] = [];
  for (let x = x0; x < x1 - 0.5; x += step) xs.push(x);
  const mark = (x: number, i: number): ReactNode => {
    switch (civ) {
      case 'camelot': // heraldic chevrons
        return <path key={i} d={`M${x},${y + 0.8} l1,-1 l1,1`} stroke="#d4a531" strokeWidth="0.45" fill="none" />;
      case 'japan': // seigaiha waves
        return <path key={i} d={`M${x},${y + 0.8} a1,1 0 0 1 2,0`} stroke="#e9e2d0" strokeWidth="0.4" fill="none" />;
      case 'kazakh': // ram's horn curls
        return <path key={i} d={`M${x + 1},${y + 0.9} c-1.2,-0.2 -1.2,-1.6 0,-1.4 m0,1.4 c1.2,-0.2 1.2,-1.6 0,-1.4`} stroke="#e3c27a" strokeWidth="0.4" fill="none" />;
      case 'russia': // diamonds
        return <path key={i} d={`M${x + 1},${y - 0.4} l0.8,0.8 l-0.8,0.8 l-0.8,-0.8 z`} fill="#e2c27a" />;
      case 'mongolia': // endless-knot squares
        return <rect key={i} x={x + 0.4} y={y - 0.4} width="1.2" height="1.2" transform={`rotate(45 ${x + 1} ${y + 0.2})`} fill="none" stroke="#e0c07a" strokeWidth="0.4" />;
    }
  };
  return <g>{xs.map(mark)}</g>;
}

/** The garment of the civilization; each one has its own cut. */
function Garment({ o, hemY, hemW, crest, full }: { o: Outfit; hemY: number; hemW: number; crest: string; full: boolean }) {
  const body = `M-5,-23 L5,-23 L4.2,-15 L${hemW},${hemY} L${-hemW + 0.6},${hemY} L-4.2,-15 Z`;
  const train = o.length === 'train' ? <path d={`M${-hemW + 0.6},${hemY} Q-9,-0.2 -13,0.2 L-2,0.2 Z`} fill={o.cloth} stroke={INK} strokeWidth="0.5" /> : null;
  const base = (fill = o.cloth) => (
    <>
      {train}
      <path d={body} fill={fill} stroke={INK} strokeWidth="0.6" strokeLinejoin="round" />
    </>
  );
  switch (o.civ) {
    case 'camelot':
      return (
        <g>
          {base()}
          {o.garment >= 1 ? ( // tabard / surcoat over the tunic
            <path d={`M-2.6,-23 L3.2,-23 L3.8,${hemY + 1.5} L-2.2,${hemY + 1.5} Z`} fill={o.garment === 2 ? '#f4efe2' : crest} stroke={INK} strokeWidth="0.5" />
          ) : null}
          {o.signature ? ( // heraldic quarters
            <>
              <rect x="-2.3" y="-22.6" width="2.9" height="3.6" fill={o.garment === 2 ? crest : '#f4efe2'} />
              <rect x="0.6" y="-19" width="2.9" height="3.6" fill={o.garment === 2 ? crest : '#f4efe2'} />
            </>
          ) : null}
        </g>
      );
    case 'japan': {
      // Haori (boxy, wide sleeves) over hakama; R1–II a plain travelling cape.
      const hakama = `M-4.4,-15 L4.4,-15 L${hemW + 0.4},${hemY} L${-hemW + 0.2},${hemY} Z`;
      return (
        <g>
          {train}
          <path d={hakama} fill={o.garment === 0 ? '#5b5446' : '#3a3a48'} stroke={INK} strokeWidth="0.6" />
          {o.garment >= 1 ? <path d={`M0,-15 L0.2,${hemY}`} stroke={INK} strokeWidth="0.4" /> : null}
          {full && o.garment >= 1 ? <path d={`M-2.2,-14 L-2.6,${hemY} M2.4,-14 L2.9,${hemY}`} stroke={INK} strokeWidth="0.25" opacity="0.6" /> : null}
          <path d="M-6,-23 L6,-23 L5.4,-13.5 L-5.4,-13.5 Z" fill={o.cloth} stroke={INK} strokeWidth="0.6" />
          <path d="M-1.2,-23 L1.6,-15" stroke={o.trim} strokeWidth="0.7" />
          {o.signature ? ( // kataginu: the stiff winged shoulder vest
            <path d="M-8,-24 L8,-24 L6.4,-21.6 L2,-21.6 L1,-15 L-1,-15 L-2,-21.6 L-6.4,-21.6 Z" fill={o.rank >= 6 ? '#2b2b3a' : o.cloakCloth} stroke={INK} strokeWidth="0.5" />
          ) : null}
        </g>
      );
    }
    case 'kazakh':
      // Chapan: long, wide, with a contrasting band along the front edge and the hem.
      return (
        <g>
          {base()}
          <path d={`M1.6,-23 L2.4,${hemY}`} stroke={o.garment === 0 ? '#c9a46a' : '#e3c27a'} strokeWidth={o.garment === 0 ? 0.9 : 1.6} />
          <path d={`M${-hemW + 0.8},${hemY - 0.6} L${hemW - 0.2},${hemY - 0.6}`} stroke={o.garment === 0 ? '#c9a46a' : '#e3c27a'} strokeWidth={o.garment === 0 ? 0.8 : 1.4} />
          {o.garment === 2 && full ? <Ornament civ="kazakh" x0={-hemW + 1.4} y={hemY - 2.4} x1={hemW - 1} /> : null}
        </g>
      );
    case 'russia':
      // Kaftan → feryaz with gold bars across the chest; from IV the long hanging sleeves behind.
      return (
        <g>
          {o.signature ? <path d={`M-4.4,-22.5 L-6.2,-22 L-7.4,${hemY + 2} L-5.6,${hemY + 2.2} Z`} fill={o.cloakCloth} stroke={INK} strokeWidth="0.5" /> : null}
          {base()}
          <path d={`M1.2,-23 L1.8,${hemY}`} stroke={INK} strokeWidth="0.4" />
          {Array.from({ length: o.garment === 0 ? 3 : 5 }, (_, i) => (
            <path key={i} d={`M-0.2,${-21.6 + i * 1.5} h3`} stroke={o.garment === 0 ? '#b49a6a' : '#e2c27a'} strokeWidth="0.7" strokeLinecap="round" />
          ))}
        </g>
      );
    case 'mongolia':
      // Deel: the diagonal overlap from the collar to the right side; a wide sash from IV.
      return (
        <g>
          {base()}
          <path d="M-0.6,-23.6 C2,-22 4.2,-20.6 4.6,-18" stroke={o.trim} strokeWidth={o.garment === 0 ? 0.8 : 1.3} fill="none" />
          {o.garment === 2 ? <path d={`M${-hemW + 0.8},${hemY - 0.5} L${hemW - 0.2},${hemY - 0.5}`} stroke={o.trim} strokeWidth="1.2" /> : null}
        </g>
      );
  }
}

function Belt({ o }: { o: Outfit }) {
  const wide = (o.civ === 'mongolia' || o.civ === 'kazakh') && o.signature;
  const color = o.civ === 'mongolia' ? '#d9a63a' : o.civ === 'japan' ? '#d9c79a' : '#4a3424';
  return (
    <g>
      <path d={`M-4.4,-15.8 L4.4,-15.8 L4.3,${wide ? -13.4 : -14.6} L-4.3,${wide ? -13.4 : -14.6} Z`} fill={color} stroke={INK} strokeWidth="0.4" />
      {o.civ === 'kazakh' && o.signature
        ? [-2.6, -0.6, 1.4, 3.2].map((x) => <rect key={x} x={x - 0.5} y="-15.4" width="1" height="1.6" rx="0.2" fill={METAL[o.metal]} />)
        : null}
      {o.civ === 'mongolia' && o.signature ? <path d="M-3.8,-13.6 l-0.6,4 M-3,-13.6 l-0.2,3.4" stroke={color} strokeWidth="0.8" /> : null}
      {o.civ !== 'kazakh' && o.civ !== 'mongolia' ? <rect x="1.6" y="-16" width="1.4" height="1.6" fill={METAL[o.metal]} stroke={INK} strokeWidth="0.25" /> : null}
    </g>
  );
}

function Satchel({ o }: { o: Outfit }) {
  return (
    <g className="env-bag">
      <path d="M3,-23 L-3.8,-14" stroke="#5a3e26" strokeWidth="0.7" />
      <path d="M-6.4,-15.4 h4.4 v3.4 a1,1 0 0 1 -1,1 h-2.4 a1,1 0 0 1 -1,-1 z" fill={o.rank === 1 ? '#7a5532' : '#8a5f36'} stroke={INK} strokeWidth="0.5" />
      <path d="M-6.4,-15.4 h4.4 v1.4 h-4.4 z" fill="#5a3e26" />
    </g>
  );
}

/** Coat of arms of the department: a small shield on the chest. */
function Crest({ color, x, y }: { color: string; x: number; y: number }) {
  return (
    <g>
      <path d={`M${x},${y} h3 v2 c0,1.4 -1.5,2.2 -1.5,2.2 c0,0 -1.5,-0.8 -1.5,-2.2 z`} fill={color} stroke="#f4efe2" strokeWidth="0.45" />
      {/* A neutral chevron and a dot — no religious or national symbol on any civilization's crest. */}
      <path d={`M${x + 0.5},${y + 2.6} l1,-1.2 l1,1.2`} stroke="#f4efe2" strokeWidth="0.45" fill="none" />
      <circle cx={x + 1.5} cy={y + 0.75} r="0.38" fill="#f4efe2" />
    </g>
  );
}

/** Japan: the family crest (mon) on the chest instead of a shield. */
function Mon({ color }: { color: string }) {
  return (
    <g>
      <circle cx="-2.6" cy="-19.6" r="1.4" fill="#f2ece0" stroke={color} strokeWidth="0.5" />
      <circle cx="-2.6" cy="-19.6" r="0.5" fill={color} />
    </g>
  );
}

function Chain({ full }: { full: boolean }) {
  return (
    <g>
      <path d="M-3.8,-22.6 Q0.4,-16.8 4,-22.6" stroke="#d4a531" strokeWidth="0.8" fill="none" strokeDasharray={full ? '0.9 0.4' : undefined} />
      <circle cx="0.2" cy="-18.6" r="0.9" fill="#d4a531" stroke={INK} strokeWidth="0.3" />
    </g>
  );
}

function Insignia() {
  const star = (cx: number, cy: number) =>
    `M${cx},${cy - 1} L${cx + 0.3},${cy - 0.3} L${cx + 1},${cy - 0.3} L${cx + 0.45},${cy + 0.15} L${cx + 0.65},${cy + 0.9} L${cx},${cy + 0.45} L${cx - 0.65},${cy + 0.9} L${cx - 0.45},${cy + 0.15} L${cx - 1},${cy - 0.3} L${cx - 0.3},${cy - 0.3} Z`;
  return (
    <g>
      <path d={star(-2.6, -17.4)} fill="#d4a531" stroke={INK} strokeWidth="0.2" />
      <path d={star(-2.6, -15)} fill="#c7ccd4" stroke={INK} strokeWidth="0.2" />
    </g>
  );
}

/** Rank VII: one medallion, five equal segments — every civilization of the Commonwealth. */
function Medallion() {
  const cx = 0.2;
  const cy = -18.2;
  const r = 1.9;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + 0.5} fill="#d4a531" stroke={INK} strokeWidth="0.3" />
      {RING.map((c, i) => {
        const a0 = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const a1 = ((i + 1) / 5) * Math.PI * 2 - Math.PI / 2;
        return <path key={c} d={`M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`} fill={c} />;
      })}
    </g>
  );
}

function Seal() {
  return (
    <g>
      <path d="M3.4,-15 v3.2" stroke="#8a3a2a" strokeWidth="0.35" />
      <circle cx="3.4" cy="-11.2" r="1.1" fill="#a3302a" stroke={INK} strokeWidth="0.3" />
    </g>
  );
}

/** The high collar; the shadow under the headwear means there is no head or face to see. */
function Collar({ o }: { o: Outfit }) {
  const color = o.rank >= 6 ? '#f3eee4' : o.rank >= 3 ? o.trim : o.cloakCloth;
  return (
    <g>
      <path d="M-2.8,-23.4 L-2.2,-26.4 L2.4,-26.4 L3,-23.4 Z" fill={color} stroke={INK} strokeWidth="0.5" />
      <ellipse cx="0.1" cy="-26.4" rx="2.3" ry="0.8" fill={SHADOW} />
    </g>
  );
}

function Headwear({ o }: { o: Outfit }) {
  const band = o.headwear;
  const s = { stroke: INK, strokeWidth: 0.5, strokeLinejoin: 'round' as const };
  switch (o.civ) {
    case 'camelot':
      if (band === 0) return <path d="M-3,-26 C-3.4,-31 -1,-33.6 1.2,-33.2 C3,-32.8 3.6,-29.4 3,-26 Z" fill={o.cloakCloth} {...s} />; // travelling hood
      if (band === 1)
        return ( // chaperon: a rolled cap with a drape behind
          <g>
            <path d="M-2.8,-27 C-5,-27 -5.6,-24 -4.8,-21.6 L-3.6,-21.8 C-3.8,-24 -3.2,-26 -2.2,-26.6 Z" fill={o.cloakCloth} {...s} />
            <ellipse cx="0.2" cy="-28.4" rx="3.4" ry="1.8" fill={o.cloakCloth} {...s} />
          </g>
        );
      return ( // beret with a plume
        <g>
          <ellipse cx="0.4" cy="-28" rx="3.8" ry="1.5" fill="#2b2b3a" {...s} />
          <path d="M2,-29 C4,-33 6.4,-33.6 7.2,-32.4 C5.6,-32.4 4.2,-31 3,-28.8 Z" fill="#f4efe2" {...s} />
        </g>
      );
    case 'japan':
      if (band === 0) return <path d="M-6.6,-27 L0.2,-31.6 L7,-27 Q0.2,-25.8 -6.6,-27 Z" fill="#d9c08a" {...s} />; // kasa straw hat
      return <path d={`M-1.8,-26.6 C-2,-${band === 1 ? 31 : 34} 0,-${band === 1 ? 32.6 : 36.2} 2.2,-${band === 1 ? 31.8 : 35.2} L2.4,-26.6 Z`} fill="#1f1f24" {...s} />; // eboshi
    case 'kazakh':
      if (band === 0)
        return ( // white felt kalpak with the split, turned-up brim
          <g>
            <path d="M-2.6,-26.6 L0.4,-33 L3.2,-26.6 Z" fill="#f3eee2" {...s} />
            <path d="M-3,-26.6 h2.6 v-1.6 h-2.2 z M0.8,-26.6 h2.6 l-0.4,-1.6 h-2.2 z" fill="#2a2520" />
          </g>
        );
      return ( // börik: round crown, fur band; VI–VII taller, with a feather
        <g>
          <path d={`M-2.6,-27.6 C-2.6,-${band === 1 ? 31 : 33.4} 3.2,-${band === 1 ? 31 : 33.4} 3.2,-27.6 Z`} fill={band === 1 ? '#7a2f2f' : '#2b4f7a'} {...s} />
          <rect x="-3.2" y="-28.2" width="7" height="1.8" rx="0.9" fill="#d9c6a4" {...s} />
          {band === 2 ? <path d="M1,-33 C1.4,-36 3,-37.4 3.4,-37 C2.6,-35.6 2,-34.2 1.6,-32.8 Z" fill="#f4efe2" {...s} /> : null}
          {band === 2 ? <circle cx="0.3" cy="-30.6" r="0.6" fill="#d4a531" /> : null}
        </g>
      );
    case 'russia':
      if (band === 0) return <path d="M-2.6,-26.6 C-3,-30.4 2.8,-31.2 3.2,-26.6 Z" fill="#6f5a46" {...s} />; // cloth cap
      if (band === 1)
        return ( // murmolka: flat crown with a fur band
          <g>
            <path d="M-2.4,-27.8 L-2.2,-31 L3,-31 L3.2,-27.8 Z" fill="#8c2f2f" {...s} />
            <rect x="-3" y="-28.6" width="6.8" height="2.2" rx="0.6" fill="#5a4636" {...s} />
          </g>
        );
      return <path d="M-2.6,-26.6 L-2.2,-37.6 L3.4,-37.6 L3.8,-26.6 Z" fill="#3a2e26" {...s} />; // tall gorlatnaya fur hat
    case 'mongolia':
      if (band === 0) return <path d="M-3,-26.4 C-3.2,-30.2 3.4,-30.6 3.6,-26.4 L2.6,-24.6 L-2.4,-24.6 Z" fill="#7f6a4d" {...s} />; // felt hat with flaps
      return ( // loovuuz: fur-lined, peaked; VI–VII with the red tassel
        <g>
          <path d="M-3.2,-26.4 L-2.6,-24 L-1.6,-26.4 Z M3.8,-26.4 L3.2,-24 L2.2,-26.4 Z" fill="#c9a77a" {...s} />
          <path d="M-2.4,-27 L0.6,-33.4 L3.4,-27 Z" fill={band === 1 ? '#2f5f8f' : '#8a3a2a'} {...s} />
          <rect x="-3" y="-27.8" width="7" height="1.6" rx="0.8" fill="#c9a77a" {...s} />
          {band === 2 ? <path d="M0.6,-33.4 l-0.8,2.4 h1.6 z" fill="#c8102e" /> : null}
        </g>
      );
  }
}

/** The front arm with what the envoy carries: a scroll, then a staff (Japan: a fan), then gold. */
function FrontArm({ o, metal, full }: { o: Outfit; metal: string; full: boolean }) {
  const has = (p: Outfit['pieces'][number]) => o.pieces.includes(p);
  const sleeve = o.civ === 'japan' && o.rank >= 3 ? 'M2.6,-23 L6.6,-23 L7,-14.6 L3.6,-14.6 Z' : 'M2.4,-23 C4.6,-22 6,-19 6.6,-15.6 L4.8,-15 C4.4,-18 3.2,-20 1.6,-21 Z';
  const staffGold = has('gold-staff');
  const staff = has('staff') || staffGold;
  return (
    <g className="env-arm">
      {staff && o.civ !== 'japan' ? <Staff civ={o.civ} gold={staffGold} /> : null}
      <path d={sleeve} fill={o.civ === 'japan' ? o.cloth : o.cloth} stroke={INK} strokeWidth="0.5" strokeLinejoin="round" />
      {o.civ === 'kazakh' && o.rank >= 3 ? <path d="M4.6,-15.2 l2,-0.6" stroke="#e3c27a" strokeWidth="0.9" /> : null}
      {staff && o.civ === 'japan' ? <Fan gold={staffGold} /> : null}
      {has('scroll') && !staff ? (
        <g className="env-scroll">
          <Scroll x={5.4} y={-16.8} ornate={false} metal={metal} />
        </g>
      ) : null}
      {has('ornate-scroll') ? (
        <g className="env-scroll">
          <Scroll x={-6.4} y={-12.4} ornate metal="#d4a531" small={!full} />
        </g>
      ) : null}
      {has('scroll') && staff ? <Scroll x={-6.2} y={-12.6} ornate={false} metal={metal} small /> : null}
    </g>
  );
}

function Scroll({ x, y, ornate, metal, small = false }: { x: number; y: number; ornate: boolean; metal: string; small?: boolean }) {
  const w = small ? 3 : 3.8;
  return (
    <g>
      <rect x={x} y={y} width={w} height="1.6" rx="0.8" fill="#efe3c4" stroke={INK} strokeWidth="0.35" />
      {ornate ? (
        <>
          <rect x={x - 0.5} y={y - 0.2} width="0.8" height="2" rx="0.3" fill={metal} />
          <rect x={x + w - 0.3} y={y - 0.2} width="0.8" height="2" rx="0.3" fill={metal} />
          <path d={`M${x + w / 2},${y + 1.6} l-0.4,1.6 M${x + w / 2},${y + 1.6} l0.5,1.5`} stroke="#a3302a" strokeWidth="0.4" />
        </>
      ) : null}
    </g>
  );
}

function Staff({ civ, gold }: { civ: OutfitCiv; gold: boolean }) {
  const c = gold ? '#d4a531' : '#c7ccd4';
  const top = (() => {
    switch (civ) {
      case 'camelot':
        return <circle cx="6.4" cy={gold ? -33 : -31.4} r={gold ? 1.3 : 0.9} fill={c} stroke={INK} strokeWidth="0.3" />;
      case 'mongolia': // tug: a spear point over a tassel of horsehair
        return (
          <g>
            <path d={`M6.4,${gold ? -36 : -34} l0.8,2.2 h-1.6 z`} fill={c} stroke={INK} strokeWidth="0.25" />
            <path d={`M5.4,${gold ? -33.8 : -31.8} q1,3.6 0,5 M6.4,${gold ? -33.8 : -31.8} v5 M7.4,${gold ? -33.8 : -31.8} q-1,3.6 0,5`} stroke={gold ? '#f3eee4' : '#2a2520'} strokeWidth="0.6" fill="none" />
          </g>
        );
      default: // kazakh, russia: a crook-like knob of the envoy's staff
        return <path d={`M6.4,${gold ? -32.4 : -31} c0,-1.6 1.8,-1.8 1.8,-0.4`} stroke={c} strokeWidth={gold ? 1.1 : 0.8} fill="none" />;
    }
  })();
  return (
    <g>
      <path d={`M6.4,${gold ? -32.6 : -31} L6.4,-0.4`} stroke={c} strokeWidth={gold ? 0.95 : 0.7} />
      {top}
    </g>
  );
}

function Fan({ gold }: { gold: boolean }) {
  return (
    <g>
      <path d="M6.2,-15.4 L4.2,-20.6 A5,5 0 0 1 9.6,-19.4 Z" fill={gold ? '#d4a531' : '#e9e2d0'} stroke={INK} strokeWidth="0.4" />
      <path d="M6.2,-15.4 L5.6,-20.4 M6.2,-15.4 L7.4,-20.4 M6.2,-15.4 L8.8,-19.6" stroke={INK} strokeWidth="0.2" />
    </g>
  );
}

/** A small banner on a pole behind the back, flying away from the head (from IV); at VII the standard of the Commonwealth. */
function BackBanner({ color, tall }: { color: string; tall: boolean }) {
  const x = -6.2;
  const topY = tall ? -41 : -35;
  return (
    <g className="env-banner">
      <path d={`M${x},-12 L${x},${topY}`} stroke="#5a3e26" strokeWidth="0.6" />
      {tall ? (
        <g>
          <rect x={x - 7.2} y={topY + 0.4} width="7" height="5.6" fill={color} stroke={INK} strokeWidth="0.4" />
          <circle cx={x - 3.7} cy={topY + 3.2} r="1.9" fill="none" stroke="#d4a531" strokeWidth="0.6" />
          {RING.map((c, i) => {
            const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
            return <circle key={c} cx={x - 3.7 + 1.9 * Math.cos(a)} cy={topY + 3.2 + 1.9 * Math.sin(a)} r="0.45" fill={c} />;
          })}
        </g>
      ) : (
        <path d={`M${x - 0.2},${topY + 0.4} L${x - 6},${topY + 1.8} L${x - 0.2},${topY + 3.8} Z`} fill={color} stroke={INK} strokeWidth="0.4" />
      )}
    </g>
  );
}

/** Rank VII on the map: the ring of the Great Commonwealth above the envoy. */
function CommonwealthRing() {
  const cy = -43;
  return (
    <g className="env-ring">
      <circle cx="0.3" cy={cy} r="3.2" fill="#fff6d6" fillOpacity="0.85" stroke="#d4a531" strokeWidth="0.8" />
      {RING.map((c, i) => {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        return <circle key={c} cx={0.3 + 2.2 * Math.cos(a)} cy={cy + 2.2 * Math.sin(a)} r="0.7" fill={c} />;
      })}
    </g>
  );
}
