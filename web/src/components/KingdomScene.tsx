/**
 * Decorative kingdom for the sign-in screen: an original drawing of a castle on a hill at dusk,
 * distant mountains, a few stars and slow mist. Purely a picture (aria-hidden) — the sign-in
 * works without it. Loaded lazily; with «облегчённая графика» or reduced motion the CSS stops
 * every animation (see kingdom-login.css).
 */
const STARS: [number, number, number][] = [
  [62, 70, 1.4], [140, 128, 1], [210, 54, 1.2], [288, 150, 0.9], [352, 88, 1.3], [430, 40, 1], [470, 140, 1.1],
  [540, 76, 0.9], [604, 160, 1.2], [676, 60, 1], [738, 118, 1.3], [96, 210, 0.9], [252, 230, 1], [500, 230, 0.8],
  [710, 220, 1], [30, 300, 0.8], [-180, 120, 1.1], [-90, 300, 0.9], [900, 90, 1.2], [1010, 260, 0.9], [-250, 380, 0.8], [1080, 380, 0.8], [380, 260, 0.9], [780, 300, 0.8], [160, 330, 0.7], [620, 320, 0.8],
];

/** Merlons along the top edge of a wall from x1 to x2 at height y. */
function merlons(x1: number, x2: number, y: number, w = 12, h = 10, gap = 8) {
  const out = [];
  for (let x = x1; x + w <= x2 + 0.5; x += w + gap) out.push(<rect key={x} x={x} y={y - h} width={w} height={h} />);
  return out;
}

function Tower({ x, w, top, base, roof }: { x: number; w: number; top: number; base: number; roof: number }) {
  return (
    <g>
      <rect x={x} y={top} width={w} height={base - top} />
      <path d={`M${x - 6} ${top} L${x + w / 2} ${roof} L${x + w + 6} ${top} Z`} className="ks-roof" />
      <line x1={x + w / 2} y1={roof} x2={x + w / 2} y2={roof - 26} className="ks-pole" />
      <path d={`M${x + w / 2} ${roof - 26} l22 6 l-22 7 Z`} className="ks-banner" />
    </g>
  );
}

/** `band`: the wide strip above the panel on tablets and phones — framed on the castle. */
export default function KingdomScene({ still = false, band = false }: { still?: boolean; band?: boolean }) {
  return (
    <svg className="ks" viewBox={band ? '-300 270 1400 440' : '0 0 800 1000'} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ks-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a1315" />
          <stop offset="0.55" stopColor="#10292a" />
          <stop offset="1" stopColor="#1a3a37" />
        </linearGradient>
        <radialGradient id="ks-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#d8b46a" stopOpacity="0.38" />
          <stop offset="1" stopColor="#d8b46a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ks-mist" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#9fb8b2" stopOpacity="0.16" />
          <stop offset="1" stopColor="#9fb8b2" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ks-window" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0d28f" />
          <stop offset="1" stopColor="#c9963f" />
        </linearGradient>
      </defs>

      <rect x="-400" width="1600" height="1000" fill="url(#ks-sky)" />
      <circle cx="640" cy="330" r="220" fill="url(#ks-glow)" />
      <circle cx="640" cy="330" r="34" className="ks-moon" />

      <g className="ks-stars">
        {STARS.map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} className={i % 4 === 0 ? 'ks-twinkle' : undefined} style={{ animationDelay: `${(i % 5) * 0.9}s` }} />
        ))}
      </g>

      <path className="ks-far" d="M-400 540 L-250 460 L-120 520 L0 560 L90 470 L160 520 L260 410 L340 500 L420 440 L520 520 L610 430 L700 500 L800 450 L920 520 L1040 440 L1200 500 L1200 700 L-400 700 Z" />
      <ellipse className="ks-mist ks-mist-a" cx="300" cy="590" rx="560" ry="70" fill="url(#ks-mist)" />
      <path className="ks-mid" d="M-400 680 Q-200 620 0 690 Q140 610 260 650 T520 640 Q660 600 800 660 Q1000 700 1200 640 L1200 1000 L-400 1000 Z" />

      {/* the castle on its hill */}
      <path className="ks-hill" d="M-400 830 L0 800 L120 760 Q400 600 690 760 L800 800 L1200 830 L1200 1000 L-400 1000 Z" />
      <g className="ks-castle">
        <rect x="210" y="610" width="380" height="80" />
        {merlons(210, 590, 610)}
        <Tower x={180} w={54} top={560} base={690} roof={500} />
        <Tower x={566} w={54} top={560} base={690} roof={500} />
        <rect x="310" y="500" width="180" height="120" />
        {merlons(310, 490, 500, 14, 12, 9)}
        <Tower x={275} w={46} top={450} base={620} roof={392} />
        <Tower x={479} w={46} top={450} base={620} roof={392} />
        <Tower x={372} w={56} top={400} base={510} roof={318} />
      </g>
      <g className="ks-lights">
        <path d="M384 690 v-34 a16 16 0 0 1 32 0 v34 Z" fill="url(#ks-window)" />
        {(
          [
          [392, 440], [408, 440], [292, 490], [496, 490], [340, 540], [380, 540], [420, 540], [460, 540], [198, 600], [584, 600], [290, 560], [500, 560],
          ] as [number, number][]
        ).map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x - 3} y={y} width="6" height="11" rx="3" fill="url(#ks-window)" />
        ))}
      </g>

      {/* road to the gate with a travelling envoy's lantern */}
      <path className="ks-road" d="M400 690 C380 760 300 820 250 1000" />
      {still ? (
        <circle className="ks-envoy" cx="318" cy="842" r="4" />
      ) : (
        <circle className="ks-envoy" r="4">
          <animateMotion dur="14s" repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path="M400 690 C380 760 300 820 250 1000" />
        </circle>
      )}

      <ellipse className="ks-mist ks-mist-b" cx="480" cy="820" rx="620" ry="80" fill="url(#ks-mist)" />
      <path className="ks-near" d="M-400 880 Q-100 840 0 880 Q200 830 380 870 T800 860 Q1000 840 1200 880 L1200 1000 L-400 1000 Z" />
    </svg>
  );
}
