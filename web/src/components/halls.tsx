import type { ReactNode } from 'react';
import { date, dateTime } from '../lib/format';

/**
 * The visual language of the Great Library and the Higher Archive (ADR-0034): the hall header with
 * a drawing of the interior, the three doors, the volume card, the proof badge, the archive seal,
 * the timeline. Everything here only shows what the server returned — no component decides a level,
 * a right or a count. The drawings are decorative and hidden from assistive technology.
 */
export type Level = 'chronicle' | 'library' | 'archive';
export type Status = 'active' | 'needs_review' | 'outdated';

export const HALLS: { id: Level; no: string; name: string; what: string; proof: string; open: string; from: string }[] = [
  { id: 'chronicle', no: 'Зал I', name: 'Летопись', what: 'Что произошло и чему нас научил опыт', proof: 'зарегистрировано, не проверено', open: 'Изучить историю', from: 'Запись в Летописи создаётся со страницы обращения или заседания кнопкой «Внести в Летопись».' },
  { id: 'library', no: 'Зал II', name: 'Библиотека решений', what: 'Методы и кейсы, проверенные Архивариусом', proof: 'проверено Архивариусом', open: 'Открыть знание', from: 'В Библиотеку решений запись Летописи попадает после проверки Архивариусом.' },
  { id: 'archive', no: 'Зал III', name: 'Высший Архив', what: 'Наследие, прошедшее утверждение', proof: 'утверждено как наследие', open: 'Открыть архивный том', from: 'В Высший Архив знание попадает по заключению Архивариуса и с утверждения ответственного за решения.' },
];
export const hallOf = (level: Level) => HALLS.find((h) => h.id === level)!;

const HERO: Record<Level | 'all', { title: string; sub: string; note: string }> = {
  all: {
    title: 'Великая библиотека',
    sub: 'Память решений Великого Содружества',
    note: 'Здесь сохраняются решения, подтверждённый опыт и методы, которые помогают следующим поколениям сотрудников не повторять прежние ошибки.',
  },
  chronicle: {
    title: 'Летопись',
    sub: 'Что произошло и чему нас научил опыт',
    note: 'События и решения, как они были. Запись зарегистрирована, но ещё не проверена: неудачный опыт хранится здесь наравне с удачным.',
  },
  library: {
    title: 'Библиотека решений',
    sub: 'Методы и кейсы, проверенные Архивариусом',
    note: 'Архивариус проверил происхождение, доказательства и классификацию каждой записи этого зала.',
  },
  archive: {
    title: 'Высший Архив',
    sub: 'Наследие, достойное сохранения',
    note: 'Проверенные и утверждённые знания, доступные для изучения и повторного использования в пределах своих областей применимости.',
  },
};

// ---------------------------------------------------------------------------
// Glyphs and the seal
// ---------------------------------------------------------------------------
/** The sign of a hall: a scroll, an open volume, a closed volume under a seal. */
export function HallGlyph({ level, size = 22 }: { level: Level; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      {level === 'chronicle' ? (
        <path {...p} d="M7 4h10a2 2 0 0 1 2 2v1H9V6a2 2 0 0 0-4 0v11a3 3 0 0 0 3 3h9a2 2 0 0 0 2-2v-1H9v1a2 2 0 0 1-2 2M11 10.500h5M11 13.500h5" />
      ) : level === 'library' ? (
        <path {...p} d="M12 6.500C10 5 7 4.600 4 5.200v13c3-.6 6-.2 8 1.300 2-1.500 5-1.900 8-1.300v-13c-3-.6-6-.2-8 1.300zM12 6.500v13" />
      ) : (
        <path {...p} d="M6 4h11a1 1 0 0 1 1 1v15H7a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zM5 18a2 2 0 0 1 2-2h11M12 8.200a2.300 2.300 0 1 0 0 4.600 2.300 2.300 0 0 0 0-4.600z" />
      )}
    </svg>
  );
}

/**
 * The seal of approved heritage: the gold ring with five studs — the same sign as over the gate of
 * the palace and the door of the archive on the map. It marks a level the server reported; it is
 * not a button and grants nothing.
 */
export function ArchiveSeal({ size = 44, title }: { size?: number; title?: string }) {
  const studs = [0, 1, 2, 3, 4].map((i) => ({ x: 24 + 11.5 * Math.sin((i / 5) * Math.PI * 2), y: 24 - 11.5 * Math.cos((i / 5) * Math.PI * 2) }));
  return (
    <svg className="gc-seal" viewBox="0 0 48 48" width={size} height={size} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <circle cx="24" cy="24" r="21" className="gc-seal-field" />
      <circle cx="24" cy="24" r="21" className="gc-seal-ring" />
      <circle cx="24" cy="24" r="16.5" className="gc-seal-inner" />
      {studs.map((s, i) => (
        <circle key={i} cx={s.x} cy={s.y} r="2.1" className="gc-seal-stud" />
      ))}
      <circle cx="24" cy="24" r="4.2" className="gc-seal-stud" />
    </svg>
  );
}

/** What the level says about checking: the server's own wording, with the sign of the hall. */
export function KnowledgeProofBadge({ level, proof, large = false }: { level: Level; proof: string; large?: boolean }) {
  return (
    <span className={`gc-proof${large ? ' large' : ''}`} data-level={level}>
      {level === 'archive' ? <ArchiveSeal size={large ? 30 : 18} /> : <HallGlyph level={level} size={large ? 22 : 16} />}
      <span>{proof.charAt(0).toUpperCase() + proof.slice(1)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The interior
// ---------------------------------------------------------------------------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const SPINES = ['#7a5418', '#1f5a45', '#7a2238', '#465a85', '#8a6a3a', '#5b4a3a', '#2f4f4a', '#8c3b2e'];

/**
 * A light drawing of the hall from its door: bookcases between piers, pointed arches, the central
 * aisle, light from the far window. The archive ends in closed bronze doors under the seal instead
 * of a window. Flat fills and the same outline as the buildings on the map; decorative only.
 */
export function HallInterior({ hall }: { hall: Level | 'all' }) {
  const W = 420;
  const H = 236;
  // The far wall of the nave; everything between it and the frame is drawn in one-point perspective.
  const far = { x0: 158, x1: 262, y0: 64, y1: 164 };
  const depth = [0, 0.4, 0.66, 0.84, 1];
  const L = (t: number, v: number) => ({ x: lerp(0, far.x0, t), y: lerp(lerp(0, H, v), lerp(far.y0, far.y1, v), t) });
  const R = (t: number, v: number) => ({ x: lerp(W, far.x1, t), y: lerp(lerp(0, H, v), lerp(far.y0, far.y1, v), t) });
  const q = (...p: { x: number; y: number }[]) => p.map((a) => `${a.x.toFixed(1)},${a.y.toFixed(1)}`).join(' ');
  const archive = hall === 'archive';
  const cases = [L, R].flatMap((S, side) =>
    depth.slice(0, -1).map((a, bay) => {
      const b = depth[bay + 1]!;
      const pad = (b - a) * 0.12;
      const t0 = a + pad;
      const t1 = b - pad;
      const shelves = [0.2, 0.36, 0.52, 0.68, 0.84];
      const n = Math.max(3, 9 - bay * 2);
      return (
        <g key={`${side}-${bay}`}>
          <polygon points={q(S(t0, 0.2), S(t1, 0.2), S(t1, 0.84), S(t0, 0.84))} className="gc-in-case" />
          {shelves.slice(0, -1).flatMap((v, row) =>
            Array.from({ length: n }, (_, i) => {
              const u0 = lerp(t0, t1, i / n);
              const u1 = lerp(t0, t1, (i + 0.82) / n);
              const top = v + 0.035 + ((i * 7 + row * 3 + bay) % 4) * 0.012;
              // In the archive every volume is bound alike: sealed sets, not a working shelf.
              const fill = archive ? (i % 3 === 0 ? '#7a2238' : '#5a4636') : SPINES[(i * 3 + row * 5 + bay + side) % SPINES.length]!;
              return <polygon key={`${row}-${i}`} points={q(S(u0, top), S(u1, top), S(u1, shelves[row + 1]! - 0.012), S(u0, shelves[row + 1]! - 0.012))} fill={fill} className="gc-in-book" />;
            }),
          )}
          {shelves.map((v) => (
            <line key={v} x1={S(t0, v).x} y1={S(t0, v).y} x2={S(t1, v).x} y2={S(t1, v).y} className="gc-in-shelf" />
          ))}
        </g>
      );
    }),
  );
  return (
    <svg className="gc-interior" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice">
      <rect width={W} height={H} className="gc-in-wall" />
      <polygon points={q(L(0, 0), R(0, 0), R(1, 0), L(1, 0))} className="gc-in-vault" />
      <polygon points={q(L(0, 1), R(0, 1), R(1, 1), L(1, 1))} className="gc-in-floor" />
      <polygon points={q(L(0, 0), L(1, 0), L(1, 1), L(0, 1))} className="gc-in-side" />
      <polygon points={q(R(0, 0), R(1, 0), R(1, 1), R(0, 1))} className="gc-in-side right" />
      {/* the aisle runner in the colour of the hall */}
      <polygon points={`${W * 0.36},${H} ${W * 0.64},${H} ${lerp(far.x0, far.x1, 0.62)},${far.y1} ${lerp(far.x0, far.x1, 0.38)},${far.y1}`} className="gc-in-runner" />
      {cases}
      {/* the far wall */}
      <rect x={far.x0} y={far.y0} width={far.x1 - far.x0} height={far.y1 - far.y0} className="gc-in-far" />
      {archive ? (
        <g>
          <path d={`M${far.x0 + 30},${far.y1} V${far.y0 + 44} a22,22 0 0 1 44,0 V${far.y1} Z`} className="gc-in-door" />
          <path d={`M${far.x0 + 52},${far.y0 + 22} V${far.y1} M${far.x0 + 30},${far.y0 + 58} h44 M${far.x0 + 30},${far.y0 + 78} h44`} className="gc-in-band" />
          <circle cx={far.x0 + 52} cy={far.y0 + 12} r="7" className="gc-in-seal" />
        </g>
      ) : (
        <g>
          <path d={`M${far.x0 + 32},${far.y1 - 14} V${far.y0 + 40} Q${far.x0 + 32},${far.y0 + 16} ${far.x0 + 52},${far.y0 + 8} Q${far.x0 + 72},${far.y0 + 16} ${far.x0 + 72},${far.y0 + 40} V${far.y1 - 14} Z`} className="gc-in-window" />
          <path d={`M${far.x0 + 52},${far.y0 + 8} V${far.y1 - 14} M${far.x0 + 32},${far.y0 + 46} h40 M${far.x0 + 32},${far.y0 + 68} h40`} className="gc-in-mullion" />
          <polygon points={`${far.x0 + 32},${far.y1 - 14} ${far.x0 + 72},${far.y1 - 14} ${W * 0.7},${H} ${W * 0.3},${H}`} className="gc-in-light" />
        </g>
      )}
      {/* piers and pointed arches across the nave, from the far one to the near one */}
      {[...depth.slice(1, -1)].reverse().map((t) => {
        const a = L(t, 0.2);
        const b = R(t, 0.2);
        const top = lerp(0, far.y0, t) - (1 - t) * 6;
        return (
          <g key={t}>
            <path d={`M${a.x},${a.y} Q${a.x + (b.x - a.x) * 0.08},${top + (a.y - top) * 0.25} ${(a.x + b.x) / 2},${top} Q${b.x - (b.x - a.x) * 0.08},${top + (a.y - top) * 0.25} ${b.x},${b.y}`} className="gc-in-arch" />
            <line x1={a.x} y1={a.y} x2={L(t, 1).x} y2={L(t, 1).y} className="gc-in-pier" />
            <line x1={b.x} y1={b.y} x2={R(t, 1).x} y2={R(t, 1).y} className="gc-in-pier" />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The header of a hall. `actions` are the page's own controls (back to the map, search, new record):
 * the header draws them, it does not decide which exist.
 */
export function HallHero({ hall, crumbs, actions }: { hall: Level | 'all'; crumbs?: ReactNode; actions?: ReactNode }) {
  const h = HERO[hall];
  return (
    <header className="gc-hero" data-level={hall === 'all' ? undefined : hall}>
      <div className="gc-hero-text">
        {crumbs}
        <h1 className="gc-display">{h.title}</h1>
        <p className="gc-hero-sub">{h.sub}</p>
        <p className="gc-hero-note">{h.note}</p>
        {actions ? <div className="gc-hero-actions">{actions}</div> : null}
      </div>
      <div className="gc-hero-art">
        <HallInterior hall={hall} />
      </div>
    </header>
  );
}

/** «Великая библиотека / зал / том» — where the reader is, with a way back to the catalogue and to the map. */
export function Crumbs({ trail }: { trail: { label: string; href?: string }[] }) {
  return (
    <nav className="gc-crumbs" aria-label="Где вы находитесь">
      <ol>
        {trail.map((c, i) => (
          <li key={i} aria-current={i === trail.length - 1 && !c.href ? 'page' : undefined}>
            {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The three doors
// ---------------------------------------------------------------------------
/**
 * The halls as three entrances — the same three portals as on the building on the map. `counts` is
 * what the server returned for the current search; `filtered` says so in words, so a found number
 * is never read as the size of the hall.
 */
export function HallNavigation({ hall, counts, total, filtered, onChange }: { hall: Level | 'all'; counts: Record<Level, number> | null; total: number | null; filtered: boolean; onChange: (h: Level | 'all') => void }) {
  return (
    <nav className="gc-halls" aria-label="Залы библиотеки">
      <div className="gc-halls-head">
        <h2 className="gc-halls-title">Три зала</h2>
        <button type="button" className="gc-all" aria-pressed={hall === 'all'} onClick={() => onChange('all')}>
          Все залы
          <span className="gc-all-count">{total === null ? '…' : total}</span>
        </button>
      </div>
      <div className="gc-doors">
        {HALLS.map((h) => {
          const n = counts ? counts[h.id] : null;
          return (
            <button key={h.id} type="button" className="gc-door" data-level={h.id} aria-pressed={hall === h.id} onClick={() => onChange(hall === h.id ? 'all' : h.id)}>
              <span className="gc-door-arch" aria-hidden="true">
                <svg viewBox="0 0 56 84" width="56" height="84" focusable="false">
                  <path className="gc-door-stone" d="M2 84V30C2 14 14 5 28 1c14 4 26 13 26 29v54z" />
                  <path className="gc-door-leaf" d="M9 84V32c0-12 9-19 19-23 10 4 19 11 19 23v52z" />
                  <circle className="gc-door-medal" cx="28" cy="27" r="6.5" />
                </svg>
                <span className="gc-door-glyph">
                  <HallGlyph level={h.id} size={24} />
                </span>
              </span>
              <span className="gc-door-body">
                <span className="gc-door-no">{h.no}</span>
                <span className="gc-door-name">{h.name}</span>
                <span className="gc-door-what">{h.what}</span>
                <span className="gc-door-foot">
                  <span className="gc-door-count">{n === null ? '…' : n}</span>
                  <span>{n === null ? 'загружаем' : filtered ? 'найдено по запросу' : records(n)}</span>
                </span>
                <span className="gc-door-proof">{h.proof.charAt(0).toUpperCase() + h.proof.slice(1)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
const mod = (n: number, one: string, few: string, many: string) => (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
export const records = (n: number) => mod(n, 'запись доступна вам', 'записи доступны вам', 'записей доступно вам');

// ---------------------------------------------------------------------------
// A volume in the catalogue
// ---------------------------------------------------------------------------
export interface VolumeRow {
  id: string;
  level: Level;
  hall: string;
  proof: string;
  status: Status;
  statusTitle: string;
  review: string;
  kindTitle: string;
  title: string;
  summary: string;
  version: number;
  sources: string[];
  applications: number;
  lastVerifiedAt: string | null;
  stale: boolean;
  /** The archivist's conclusion of the current version, when it has one. */
  conclusion?: { category: string | null; proof: string | null; applicability: string | null; basis: string | null; lastChecked: string | null } | null;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One volume: what it is, how far it has been checked, where it came from. The whole card is the link. */
export function KnowledgeVolumeCard({ r }: { r: VolumeRow }) {
  const h = hallOf(r.level);
  const c = r.level === 'archive' ? r.conclusion : null;
  return (
    <a className="volume gc-vol" data-level={r.level} data-status={r.status} href={`#/library/${r.id}`}>
      <span className="gc-vol-spine" aria-hidden="true">
        <HallGlyph level={r.level} size={20} />
      </span>
      <span className="gc-vol-body">
        <span className="gc-vol-kicker">
          <span className="gc-vol-kind">{r.kindTitle}</span>
          <KnowledgeProofBadge level={r.level} proof={r.proof} />
        </span>
        <span className="gc-vol-title">{r.title}</span>
        {r.summary ? <span className="gc-vol-summary">{r.summary}</span> : null}
        {r.status !== 'active' || r.review !== 'none' || r.stale ? (
          <span className="gc-vol-flags">
            {r.status === 'outdated' ? <span className="gc-flag outdated">Устарело: история сохранена</span> : null}
            {r.status === 'needs_review' ? <span className="gc-flag review">Требует повторной проверки</span> : null}
            {r.review === 'library_proposed' ? <span className="gc-flag wait">Ждёт проверки Архивариуса</span> : null}
            {r.review === 'archive_proposed' ? <span className="gc-flag wait">Заключение у Совета</span> : null}
            {r.stale ? <span className="gc-flag review">Давно не проверялось</span> : null}
          </span>
        ) : null}
        {c ? (
          <span className="gc-vol-archive">
            {c.category ? <Fact k="Категория" v={c.category} /> : null}
            {c.proof ? <Fact k="Доказанность" v={c.proof} /> : null}
            {c.applicability ? <Fact k="Применимость" v={c.applicability} /> : null}
            {c.basis ? <Fact k="Основания включения" v={c.basis} /> : null}
          </span>
        ) : null}
        <span className="gc-vol-meta">
          <Fact k="Зал" v={r.hall} />
          <Fact k="Состояние" v={cap(r.statusTitle)} />
          <Fact k={r.sources.length > 1 ? 'Источники' : 'Источник'} v={r.sources.length ? r.sources.join(', ') : 'не указан'} />
          <Fact k="Версия" v={String(r.version)} />
          {r.applications ? <Fact k="Повторное применение" v={`${r.applications} ${mod(r.applications, 'раз', 'раза', 'раз')}`} /> : null}
          {r.lastVerifiedAt ? <Fact k="Проверено" v={date(r.lastVerifiedAt)} /> : c?.lastChecked ? <Fact k="Проверено" v={date(c.lastChecked)} /> : null}
        </span>
        <span className="gc-vol-open">{h.open}</span>
      </span>
      {r.level === 'archive' ? <ArchiveSeal size={38} /> : null}
    </a>
  );
}
function Fact({ k, v }: { k: string; v: string }) {
  return (
    <span className="gc-fact">
      <span className="gc-fact-k">{k}</span>
      <span className="gc-fact-v">{v}</span>
    </span>
  );
}

/** The catalogue while it loads: the geometry of real cards, so nothing jumps when they arrive. */
export function VolumeSkeleton({ n = 4 }: { n?: number }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Загружаем каталог…</span>
      <ol className="gc-volumes" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <li key={i}>
            <span className="gc-vol gc-vol-skeleton">
              <span className="gc-vol-spine" />
              <span className="gc-vol-body">
                <span className="gc-bone" style={{ width: '38%' }} />
                <span className="gc-bone tall" style={{ width: '82%' }} />
                <span className="gc-bone" style={{ width: '96%' }} />
                <span className="gc-bone" style={{ width: '64%' }} />
                <span className="gc-bone" style={{ width: '48%', marginTop: 14 }} />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inside a volume
// ---------------------------------------------------------------------------
/** A numbered section of the reading view: the numbers are the order in which a case is read. */
export function ReadingSection({ no, title, id, children }: { no: string; title: string; id?: string; children: ReactNode }) {
  return (
    <section className="gc-sec" id={id}>
      <h2 className="gc-sec-h">
        <span className="gc-sec-no" aria-hidden="true">
          {no}
        </span>
        {title}
      </h2>
      <div className="gc-sec-body">{children}</div>
    </section>
  );
}
/** Text of a card field, or an unobtrusive «Не указано»: nothing is written in for the author. */
export function Prose({ v }: { v?: string | null }) {
  return v ? <p className="gc-prose">{v}</p> : <p className="gc-none">Не указано</p>;
}

export interface TimelineEvent {
  at: string;
  what: string;
  who: string | null;
  source: string;
  link: string | null;
}
/**
 * The chronicle of one piece of knowledge, built only from the events the server returned. Acts of
 * the library itself — checks, approvals, re-checks — stand out from the events of the sources.
 */
export function KnowledgeTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) return <p className="gc-none">Событий пока нет.</p>;
  return (
    <ol className="gc-timeline">
      {events.map((e, i) => {
        const kind = e.source === 'Великая библиотека' ? 'library' : e.source.startsWith('заседание') ? 'meeting' : 'item';
        return (
          <li key={i} className="gc-event" data-kind={kind}>
            <span className="gc-event-dot" aria-hidden="true" />
            <time className="gc-event-when" dateTime={e.at}>
              {dateTime(e.at)}
            </time>
            <span className="gc-event-what">{e.link ? <a href={e.link}>{e.what}</a> : e.what}</span>
            <span className="gc-event-meta">
              <span className="gc-event-kind">{kind === 'library' ? 'Великая библиотека' : cap(e.source)}</span>
              {e.who ? <span>{e.who}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
