/**
 * Heraldic crest for a sign-in character: a shield in the colour of the person's district style
 * (or the crown for the leadership), with an original emblem. A picture of a style — it says
 * nothing about rights, which come only from roles.
 */
export type CrestKind = 'crown' | 'camelot' | 'japan' | 'kazakh' | 'russia' | 'mongolia' | 'plain';

const FIELD: Record<CrestKind, string> = {
  crown: '#2c3a2f',
  camelot: '#23394a',
  japan: '#4a2a2a',
  kazakh: '#1f4448',
  russia: '#3f2f22',
  mongolia: '#3b3a26',
  plain: '#2a3336',
};

export function crestKind(civilization: string | null | undefined, rank: string | null | undefined): CrestKind {
  if (rank === 'king' || rank === 'regent') return 'crown';
  if (civilization === 'camelot' || civilization === 'japan' || civilization === 'kazakh' || civilization === 'russia' || civilization === 'mongolia') return civilization;
  return 'plain';
}

function Emblem({ kind }: { kind: CrestKind }) {
  switch (kind) {
    case 'crown':
      return <path d="M13 29 L11 17 L16.5 22 L20 14 L23.5 22 L29 17 L27 29 Z M13 31 h14 v2.5 H13 Z" />;
    case 'camelot':
      return <path d="M14 32 V20 h2.5 v2.5 h2.5 V20 h2 v2.5 h2.5 V20 H26 v12 Z M18.5 32 v-4 a1.5 1.5 0 0 1 3 0 v4 Z" fillRule="evenodd" />;
    case 'japan':
      return <path d="M10.5 18 Q20 15 29.5 18 L28.5 20.5 Q20 18.5 11.5 20.5 Z M13 22 h14 v2 H13 Z M15 24 h2 v9 h-2 Z M23 24 h2 v9 h-2 Z" />;
    case 'kazakh':
      return (
        <g>
          <circle cx="20" cy="24" r="7.5" fill="none" strokeWidth="2" stroke="currentColor" />
          <path d="M20 16.5 V31.5 M14 19 L26 29 M26 19 L14 29" strokeWidth="1.6" stroke="currentColor" fill="none" />
        </g>
      );
    case 'russia':
      return <path d="M20 13 q5.5 5 5.5 9 q0 3.5 -5.5 4 q-5.5 -0.5 -5.5 -4 q0 -4 5.5 -9 Z M15.5 27 h9 v6 h-9 Z" />;
    case 'mongolia':
      return <path d="M19 12 h2 v21 h-2 Z M15 15 q5 4 10 0 q-1 6 -5 7 q-4 -1 -5 -7 Z" />;
    default:
      return <circle cx="20" cy="24" r="4" />;
  }
}

export function Crest({ kind, size = 44 }: { kind: CrestKind; size?: number }) {
  return (
    <svg className={`crest crest-${kind}`} width={size} height={size} viewBox="0 0 40 44" aria-hidden="true" focusable="false">
      <path d="M4 4 H36 V20 C36 31 28.5 38 20 41 C11.5 38 4 31 4 20 Z" fill={FIELD[kind]} />
      <path d="M4 4 H36 V20 C36 31 28.5 38 20 41 C11.5 38 4 31 4 20 Z" fill="none" className="crest-rim" strokeWidth="1.5" />
      <g className="crest-emblem">
        <Emblem kind={kind} />
      </g>
    </svg>
  );
}
