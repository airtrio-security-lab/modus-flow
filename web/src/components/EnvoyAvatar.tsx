import { CIV_STYLES, MOTION_WORDS, envoyRankName, outfit, outfitWords, type EnvoyMotion } from '../lib/envoy-outfits';
import { EnvoyFigure } from './EnvoyFigure';

/**
 * EnvoyAvatar (owner brief «The Living Envoy», ADR-0036): the ONE envoy of a person — the same rank and
 * the same attire wherever it is drawn. It takes only what the server reported: the confirmed rank, the
 * civilization of the person's department and the state of the item it carries.
 *
 *   variant="map"      compact, recognizable at map scale (I–II plain, III–IV insignia, V–VI regalia, VII ring);
 *   variant="profile"  large, with the details of the clothes, heraldry and awards.
 *
 * The coat of arms is the civilization's own colour, not the colour of the castle the item goes to,
 * so the person's map envoys and the profile look alike. Nothing here grants anything.
 */
export interface EnvoyAvatarProps {
  civ: string | null | undefined;
  rank: number;
  variant?: 'map' | 'profile';
  /** State of the item the envoy carries (map); omitted on the profile. */
  state?: EnvoyMotion;
  /** Walk (only while the envoy really moves, or for the viewer's own envoy on the road). */
  walking?: boolean;
  /** Height in px of the standalone picture. */
  size?: number;
  /** Accessible name; omitted → decorative. */
  label?: string;
}

export const crestOf = (civ: string | null | undefined) => CIV_STYLES[outfit(civ, 1).civ].palette.robe2;

/** The figure as an SVG group, for drawing inside the map's own <svg>. Feet at 0, facing right. */
export function EnvoyAvatarMark({ civ, rank, state, walking = false, variant = 'map' }: Omit<EnvoyAvatarProps, 'size' | 'label'>) {
  return (
    <g className={`env-avatar env-${variant}${state ? ` env-state-${state}` : ''}`} data-state={state}>
      <EnvoyFigure civ={civ} rank={rank} crest={crestOf(civ)} detail={variant === 'profile' ? 'full' : 'map'} walking={walking} />
      {state === 'waiting' ? <Hourglass /> : null}
      {state === 'received' ? <Received /> : null}
    </g>
  );
}

/** A standalone picture: the profile card, the rank-up card, the ladder, the legend. */
export function EnvoyAvatar({ civ, rank, variant = 'profile', state, walking = false, size, label }: EnvoyAvatarProps) {
  const h = size ?? (variant === 'profile' ? 220 : 40);
  return (
    <svg
      className={`env-portrait env-portrait-${variant}`}
      viewBox="-16 -48 32 50"
      width={h * (32 / 50)}
      height={h}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-rank={rank}
    >
      {label ? <title>{label}</title> : null}
      <EnvoyAvatarMark civ={civ} rank={rank} variant={variant} state={state} walking={walking} />
    </svg>
  );
}

/** Words for the same picture: «Посол ранга Герольд, Казахское ханство: …; ожидает ответа». */
export function avatarWords(civ: string | null | undefined, rank: number, state?: EnvoyMotion) {
  const o = outfit(civ, rank);
  return `Посол ранга ${envoyRankName(rank)}, ${CIV_STYLES[o.civ].name}: ${outfitWords(o)}${state ? `; ${MOTION_WORDS[state]}` : ''}`;
}

/** «Ожидает ответа»: a small hourglass beside the envoy — it stands still, nothing is claimed. */
function Hourglass() {
  return (
    <g className="env-sign env-sign-wait" transform="translate(-10.5,-31)">
      <circle r="3.6" fill="#fbf0e1" stroke="#97540a" strokeWidth="0.7" />
      <path d="M-1.5,-2 h3 l-1.2,2 l1.2,2 h-3 l1.2,-2 z" fill="#97540a" />
    </g>
  );
}

/** «Принят»: the responsible person's first answer is recorded — a green seal at the shoulder. */
function Received() {
  return (
    <g className="env-sign env-sign-received" transform="translate(10.5,-31)">
      <circle r="3.6" fill="#e5f2ea" stroke="#2e7a4e" strokeWidth="0.7" />
      <path d="M-1.7,0 l1.2,1.3 l2.3,-2.7" fill="none" stroke="#2e7a4e" strokeWidth="0.9" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
}
