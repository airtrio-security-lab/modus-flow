import { World, type DistrictIn, type Quality, type View } from './world';
import type { CivId } from './kits';

/**
 * Review harness of the 3D kits (dev only, not part of the product build): the same engine with
 * synthetic districts, driven by the query string. Used for screenshot review of 4 civilizations × 5 levels.
 *   ?set=camelot            five districts of one civilization, levels 1…5
 *   ?focus=2                frame district #2;  ?focus=palace|library|plaza|camp
 *   ?q=high|medium|low      quality tier;       ?view=x,z,dist,az,pol
 */
const q = new URLSearchParams(location.search);
const COLORS = ['#a2412f', '#2f4f7a', '#9a6d12', '#4d7448', '#73466a', '#2b6f6a', '#8a5a2b', '#55606e'];
const CIVS: CivId[] = ['camelot', 'japan', 'kazakh', 'mongolia'];
const set = q.get('set') as CivId | null;
const districts: DistrictIn[] = set
  ? [1, 2, 3, 4, 5].map((level, i) => ({ id: `d${i}`, name: `${set} ${level}`, civ: set, level, color: COLORS[i]! }))
  : Array.from({ length: Number(q.get('n') ?? 8) }, (_, i) => ({ id: `d${i}`, name: `d${i}`, civ: CIVS[i % 4]!, level: Number(q.get('level') ?? [5, 4, 3, 5, 2, 4, 1, 3][i % 8]), color: COLORS[i % 8]! }));
const host = document.getElementById('host')!;
const t0 = performance.now();
const world = new World(document.getElementById('c') as HTMLCanvasElement, host, (q.get('q') as Quality) ?? 'high');
world.resize(host.clientWidth, host.clientHeight);
const t1 = performance.now();
world.setData({ districts, achievements: Number(q.get('ach') ?? 7) });
const t2 = performance.now();
world.renderNow();
(window as unknown as { timing: object }).timing = { engineMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), firstFrameMs: Math.round(performance.now() - t2) };
world.setEnvoys(
  q.get('envoys') === '0'
    ? []
    : districts.flatMap((d, i) => [0.05, 0.35, 0.62, 0.95].slice(0, 1 + (i % 4)).map((t, k) => ({ id: `${d.id}-${k}`, districtId: d.id, t, tone: (k === 2 ? 'late' : k === 1 ? 'mine' : 'normal') as 'late' | 'mine' | 'normal' }))).concat([{ id: 'w1', districtId: null as unknown as string, t: 0, tone: 'normal' }]),
);
const focus = q.get('focus');
if (focus) {
  const v = world.viewOf(/^\d+$/.test(focus) ? `d${focus}` : focus);
  if (v) world.setView({ ...v, dist: Number(q.get('dist') ?? v.dist), pol: Number(q.get('pol') ?? v.pol), az: v.az + Number(q.get('daz') ?? 0) });
}
const view = q.get('view');
if (view) {
  const [x, z, dist, az, pol] = view.split(',').map(Number);
  world.setView({ x, z, dist, az, pol } as View);
}
addEventListener('resize', () => world.resize(host.clientWidth, host.clientHeight));
addEventListener('keydown', (e) => {
  const map: Record<string, Parameters<World['nudge']>[0]> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', q: 'ccw', e: 'cw', Home: 'home' };
  const k = map[e.key];
  if (k) world.nudge(k);
});
(window as unknown as { world: World }).world = world;
document.title = 'ready';
