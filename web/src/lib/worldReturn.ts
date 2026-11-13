/**
 * Seamless world (ADR-0038): where in the game world the person was when they entered a building,
 * so that coming back puts them there again — the same city or department, the same camera, the same
 * selection — instead of the opening view.
 *
 * What is kept is navigation only: ids, a route and five camera numbers. No names, no texts, no
 * rights. It lives in `sessionStorage` (this tab, gone with it) under one key, is bound to the
 * organization and the membership it was written for, and expires. Nothing here is trusted: the route
 * is matched against a whitelist, numbers must be finite, and ids are checked against what the server
 * returns now (`reconcile`) before anything is restored.
 *
 * The first half of this file is pure (no DOM, no storage) and is covered by
 * `test/platform/world-return.test.ts`.
 */

export interface WorldView {
  x: number;
  z: number;
  dist: number;
  az: number;
  pol: number;
}
export type WorldMode = '3d' | 'city' | 'work';

export interface WorldContext {
  v: 1;
  org: string;
  member: string;
  /** The world screen the person left for a working screen; null while they are in the world. */
  from: string | null;
  mode: WorldMode | null;
  /** The 3D camera as it was BEFORE the flight into the building. */
  view: WorldView | null;
  /** The selected department (its castle). */
  selected: string | null;
  /** The building that was entered: `library`, `archive`, `palace`, … */
  place: string | null;
  at: number;
}

/** A context older than this is history: the person gets the ordinary opening view. */
export const TTL_MS = 8 * 3600 * 1000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WORLD_ROUTE = new RegExp(`^#/(kingdom|castles/${UUID}(/[a-z0-9-]{1,24})?)$`);
const ID = /^[a-z0-9-]{1,40}$/i;

/** `#/kingdom?diag=1` → `#/kingdom`; anything that is not a world screen → null. */
export function worldRoute(hash: string): string | null {
  const path = (hash.split('?')[0] ?? '').replace(/\/+$/, '');
  return WORLD_ROUTE.test(path) ? path : null;
}

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
function viewOf(v: unknown): WorldView | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!num(o.x) || !num(o.z) || !num(o.dist) || !num(o.az) || !num(o.pol)) return null;
  if (o.dist <= 0 || Math.abs(o.x) > 1e5 || Math.abs(o.z) > 1e5 || o.dist > 1e5) return null;
  return { x: o.x, z: o.z, dist: o.dist, az: o.az, pol: o.pol };
}
const idOf = (s: unknown): string | null => (typeof s === 'string' && ID.test(s) ? s : null);

/** The stored text → a context for THIS reader, or null: foreign, expired, malformed. */
export function parseWorldContext(raw: string | null, who: { org: string; member: string }, now: number): WorldContext | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    const j: unknown = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    o = j as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.v !== 1 || o.org !== who.org || o.member !== who.member) return null;
  if (!num(o.at) || o.at > now + 60_000 || now - o.at > TTL_MS) return null;
  const mode = o.mode === '3d' || o.mode === 'city' || o.mode === 'work' ? o.mode : null;
  return {
    v: 1,
    org: who.org,
    member: who.member,
    from: typeof o.from === 'string' ? worldRoute(o.from) : null,
    mode,
    view: viewOf(o.view),
    selected: idOf(o.selected),
    place: idOf(o.place),
    at: o.at,
  };
}

/**
 * Against what the server returns now: a department that no longer exists (or is no longer shown to
 * this person) is not selected again, and a return route into it falls back to the city.
 */
export function reconcile(ctx: WorldContext, departmentIds: readonly string[]): WorldContext {
  const known = new Set(departmentIds);
  const selected = ctx.selected && known.has(ctx.selected) ? ctx.selected : null;
  const castle = ctx.from?.match(/^#\/castles\/([0-9a-f-]{36})/)?.[1];
  const from = castle && !known.has(castle) ? '#/kingdom' : ctx.from;
  return { ...ctx, selected, from };
}

export function mergeWorldContext(prev: WorldContext | null, who: { org: string; member: string }, patch: Partial<Omit<WorldContext, 'v' | 'org' | 'member' | 'at'>>, now: number): WorldContext {
  const base: WorldContext = prev ?? { v: 1, org: who.org, member: who.member, from: null, mode: null, view: null, selected: null, place: null, at: now };
  return { ...base, ...patch, v: 1, org: who.org, member: who.member, at: now };
}

/** What the link back says. The department's name comes from the directory the reader already has. */
export function returnLabel(from: string, departments: readonly { id: string; name: string }[]): string {
  const castle = from.match(/^#\/castles\/([0-9a-f-]{36})/)?.[1];
  if (!castle) return 'Вернуться в Содружество';
  const d = departments.find((x) => x.id === castle);
  return d ? `Вернуться в город отдела «${d.name}»` : 'Вернуться в город отдела';
}

// ---------------------------------------------------------------------------
// Storage: this tab only. Every call survives a missing or blocked storage.
// ---------------------------------------------------------------------------
const KEY = 'modus.world.return';
const EVENT = 'modus:world-return';

/** Screens that show the way back re-read it; typed loosely so the pure half stays checkable without a DOM. */
const announce = () => (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent?.(new Event(EVENT));

export function readWorldContext(who: { org: string; member: string }): WorldContext | null {
  try {
    return parseWorldContext(sessionStorage.getItem(KEY), who, Date.now());
  } catch {
    return null;
  }
}

export function writeWorldContext(who: { org: string; member: string }, patch: Partial<Omit<WorldContext, 'v' | 'org' | 'member' | 'at'>>): void {
  try {
    const now = Date.now();
    const next = mergeWorldContext(parseWorldContext(sessionStorage.getItem(KEY), who, now), who, patch, now);
    sessionStorage.setItem(KEY, JSON.stringify(next));
    announce();
  } catch {
    /* not remembered: the world opens on its ordinary view */
  }
}

export function clearWorldContext(): void {
  try {
    sessionStorage.removeItem(KEY);
    // The key of the first version of the camera memory: not bound to an organization.
    sessionStorage.removeItem('modus.w3d.view');
    announce();
  } catch {
    /* ignore */
  }
}

export const WORLD_RETURN_EVENT = EVENT;
