import type { ReactNode } from 'react';
import { civOf, type Civ } from './civ';

/**
 * Council scenes (ADR-0020): the interior of each small council place and of the Great Round Table.
 * Original flat drawings, decoration only. Every scene sits above the same working components
 * (agenda, participants, documents, arguments, recommendations, decisions, deadlines, protocol,
 * history) — the business process never depends on the picture. Representatives «arrive» with a
 * short animation, switched off in light graphics and with reduced motion.
 */
const W = 640;
const H = 170;

export function CouncilScene({ place, color = '#a2412f', seats = [], label }: { place: Civ | 'great' | string; color?: string; seats?: string[]; label: string }) {
  const kind = place === 'great' ? 'great' : civOf(place);
  return (
    <figure className={`scene scene-${kind}`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
        {kind === 'japan' ? <Japan color={color} /> : kind === 'kazakh' ? <Kazakh color={color} /> : kind === 'mongolia' ? <Mongolia color={color} /> : kind === 'great' ? <Great /> : <Camelot color={color} />}
        <Arrivals seats={seats} great={kind === 'great'} />
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

function Japan({ color }: { color: string }) {
  const panels: ReactNode[] = [];
  for (let i = 0; i < 8; i++) {
    const x = 20 + i * 76;
    panels.push(
      <g key={i}>
        <rect x={x} y={14} width={70} height={92} fill="#f4efe1" stroke="#4b3a2a" strokeWidth="3" />
        {[1, 2, 3].map((k) => <line key={`v${k}`} x1={x + (70 / 4) * k} y1={14} x2={x + (70 / 4) * k} y2={106} stroke="#7a6247" strokeWidth="1" />)}
        {[1, 2, 3, 4].map((k) => <line key={`h${k}`} x1={x} y1={14 + (92 / 5) * k} x2={x + 70} y2={14 + (92 / 5) * k} stroke="#7a6247" strokeWidth="1" />)}
      </g>,
    );
  }
  return (
    <g>
      <rect width={W} height={H} fill="#e7dcc4" />
      {panels}
      <rect x="0" y="0" width={W} height="14" fill="#3d2f22" />
      {/* Tatami floor. */}
      <rect x="0" y="106" width={W} height={H - 106} fill="#cdbf8c" />
      {[0, 1, 2, 3, 4].map((i) => <rect key={i} x={i * 128} y={106} width={128} height={H - 106} fill="none" stroke="#5d4a2c" strokeWidth="2" />)}
      {/* The lord's banner with a round crest in the department colour. */}
      <rect x={W / 2 - 34} y={20} width={68} height={80} fill="#fbf7ec" stroke="#4b3a2a" strokeWidth="2" />
      <circle cx={W / 2} cy={58} r={20} fill={color} />
      {/* A low table. */}
      <rect x={W / 2 - 110} y={128} width={220} height={14} rx="3" fill="#5a3d26" />
    </g>
  );
}

function Kazakh({ color }: { color: string }) {
  const poles: ReactNode[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = (W / 16) * i;
    poles.push(<line key={i} x1={W / 2} y1={-30} x2={x} y2={70} stroke="#b0412d" strokeWidth="3" />);
  }
  const lattice: ReactNode[] = [];
  for (let x = -40; x < W + 40; x += 22) {
    lattice.push(<line key={`a${x}`} x1={x} y1={70} x2={x + 36} y2={118} stroke="#9c7a4c" strokeWidth="2" />);
    lattice.push(<line key={`b${x}`} x1={x + 36} y1={70} x2={x} y2={118} stroke="#9c7a4c" strokeWidth="2" />);
  }
  return (
    <g>
      <rect width={W} height={H} fill="#f2e6cf" />
      {poles}
      <ellipse cx={W / 2} cy={-14} rx="60" ry="26" fill="#f7d488" stroke="#9c6f22" strokeWidth="4" />
      <rect x="0" y="70" width={W} height="48" fill="#ead6ab" />
      {lattice}
      {/* A wall rug with a simple diamond ornament. */}
      <rect x={W / 2 - 90} y={74} width={180} height={40} fill="#a2412f" stroke="#6d2a1e" strokeWidth="2" />
      {[0, 1, 2, 3].map((i) => <path key={i} d={`M${W / 2 - 66 + i * 44},94 l12,-12 l12,12 l-12,12 Z`} fill="#f4d79a" />)}
      <rect x="0" y="118" width={W} height={H - 118} fill="#8c2f22" />
      <path d={`M0,132 H${W}`} stroke="#e9c27a" strokeWidth="3" strokeDasharray="14 8" />
      <ellipse cx={W / 2} cy={148} rx="92" ry="14" fill="#5a3d26" />
      <rect x={30} y={78} width={16} height={34} fill={color} />
    </g>
  );
}

function Mongolia({ color }: { color: string }) {
  const poles: ReactNode[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = (W / 12) * i;
    poles.push(<line key={i} x1={W / 2} y1={-20} x2={x} y2={64} stroke={i % 2 ? '#e08a2e' : '#2f4f7a'} strokeWidth="4" />);
  }
  return (
    <g>
      <rect width={W} height={H} fill="#f6f2e6" />
      {poles}
      <circle cx={W / 2} cy={-12} r="34" fill="#e08a2e" stroke="#2f4f7a" strokeWidth="5" />
      <rect x="0" y="64" width={W} height="54" fill="#efe7d3" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <rect key={i} x={i * 80 + 6} y={70} width={68} height={42} fill="none" stroke="#2f4f7a" strokeWidth="2" />)}
      {/* Two standards: white for peace, dark for the field. */}
      {[[80, '#f4efe2'], [W - 80, '#2d2a24']].map(([x, c]) => (
        <g key={String(x)}>
          <line x1={x as number} y1={150} x2={x as number} y2={40} stroke="#4a4034" strokeWidth="3" />
          <path d={`M${(x as number) - 10},${46} Q${x},${86} ${(x as number) + 10},${46} Z`} fill={c as string} stroke="#4a4034" strokeWidth="1.5" />
        </g>
      ))}
      <rect x="0" y="118" width={W} height={H - 118} fill="#c7b37f" />
      {/* The hearth in the middle. */}
      <rect x={W / 2 - 22} y={122} width={44} height={30} fill="#3c3530" />
      <rect x={W / 2 - 6} y={60} width={12} height={62} fill="#3c3530" />
      <rect x={W / 2 - 140} y={140} width={80} height={10} fill={color} />
    </g>
  );
}

function Camelot({ color }: { color: string }) {
  const bricks: ReactNode[] = [];
  for (let row = 0; row < 6; row++) for (let i = -1; i < 14; i++) bricks.push(<rect key={`${row}-${i}`} x={i * 50 + (row % 2) * 25} y={row * 20} width={50} height={20} fill="none" stroke="#9a9384" strokeWidth="1.2" />);
  return (
    <g>
      <rect width={W} height={H} fill="#c9c3b4" />
      {bricks}
      {[110, W / 2, W - 110].map((x) => (
        <path key={x} d={`M${x - 26},104 V44 A26,26 0 0 1 ${x + 26},44 V104 Z`} fill="#8fb3c9" stroke="#5d564a" strokeWidth="4" />
      ))}
      {[200, W - 200].map((x) => (
        <g key={x}>
          <rect x={x - 22} y={10} width={44} height={70} fill={color} />
          <path d={`M${x - 22},80 L${x},96 L${x + 22},80 Z`} fill={color} />
          <path d={`M${x - 10},30 h20 v12 q0,14 -10,20 q-10,-6 -10,-20 Z`} fill="#f2e6c3" />
        </g>
      ))}
      <rect x="0" y="120" width={W} height={H - 120} fill="#7b6a55" />
      {/* The long table of the knights' council. */}
      <rect x={70} y={128} width={W - 140} height={18} rx="4" fill="#5a3d26" />
    </g>
  );
}

/** The Great Round Table: one table, four equal banners — no civilization owns the hall. */
function Great() {
  const banners: [string, string][] = [['#55606e', 'Камелот'], ['#a2412f', 'Японский сёгунат'], ['#c99a2e', 'Казахское ханство'], ['#2f4f7a', 'Монгольская держава']];
  return (
    <g>
      <rect width={W} height={H} fill="#2b3134" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={i * 96 - 10} y={0} width={60} height={110} fill="#343c3f" />)}
      {banners.map(([c, name], i) => (
        <g key={name}>
          <title>{name}</title>
          <rect x={86 + i * 132} y={12} width={40} height={66} fill={c} />
          <path d={`M${86 + i * 132},78 L${106 + i * 132},92 L${126 + i * 132},78 Z`} fill={c} />
        </g>
      ))}
      <rect x="0" y="110" width={W} height={H - 110} fill="#3a3330" />
      <ellipse cx={W / 2} cy={138} rx={200} ry={26} fill="#6b4a2c" stroke="#c99a2e" strokeWidth="3" />
      <ellipse cx={W / 2} cy={134} rx={60} ry={8} fill="#7d5a37" />
    </g>
  );
}

/** Representatives taking their seats: one figure per participant, coloured by their district's style. */
function Arrivals({ seats, great }: { seats: string[]; great: boolean }) {
  const tone: Record<string, string> = { camelot: '#55606e', japan: '#a2412f', kazakh: '#c99a2e', mongolia: '#2f4f7a' };
  const shown = seats.slice(0, 12);
  const span = great ? 380 : 300;
  return (
    <g aria-hidden="true">
      {shown.map((civ, i) => {
        const x = W / 2 - span / 2 + (span / Math.max(shown.length - 1, 1)) * i;
        const y = great ? 118 + (i % 2) * 6 : 120;
        return (
          <g key={i} className="scene-arrive" style={{ animationDelay: `${i * 0.12}s` }} transform={`translate(${x},${y})`}>
            <path d="M-7,0 L0,-20 L7,0 Z" fill={tone[civ] ?? '#7a6a52'} stroke="#1f1b16" strokeWidth="1" />
            <circle cy="-24" r="5" fill="#f2dfc2" stroke="#1f1b16" strokeWidth="1" />
          </g>
        );
      })}
    </g>
  );
}
