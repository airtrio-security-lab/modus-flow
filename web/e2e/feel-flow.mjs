/**
 * The response layer of the 3D city (ADR-0030) in a real browser, WITHOUT the database: the product's
 * own engine in the kit harness (`web/dev/world.html`), fed with synthetic districts and envoys.
 * Checks that a response happens only on a real change of data, never blocks the scene, always ends
 * exactly where a still scene would be, and that reduced motion switches the whole layer off.
 *
 *   npm run demo:feel            (starts its own dev server; needs `playwright` and its Chromium)
 *   SHOTS=docs/demo/feel npm run demo:feel
 *
 * WebGL here is SwiftShader (software): the frame times are NOT those of a real GPU. Measure a real
 * device with the diagnostics panel: `#/kingdom?diag=1`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { BUDGET, read } from '../src/world3d/budget.ts';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.env.SHOTS;
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'error', server: { port: 5197, strictPort: false } });
await server.listen();
const BASE = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

// The harness's own data (see src/world3d/preview.ts): 8 districts, levels 5 4 3 5 2 4 1 3, envoys `d{i}-{k}`.
const CIVS = ['camelot', 'japan', 'kazakh', 'mongolia'];
const COLORS = ['#a2412f', '#2f4f7a', '#9a6d12', '#4d7448', '#73466a', '#2b6f6a', '#8a5a2b', '#55606e'];
const LEVELS = [5, 4, 3, 5, 2, 4, 1, 3];
const districts = (levels = LEVELS) => levels.map((level, i) => ({ id: `d${i}`, name: `d${i}`, civ: CIVS[i % 4], level, color: COLORS[i] }));
const envoys = () =>
  LEVELS.flatMap((_, i) => [0.05, 0.35, 0.62, 0.95].slice(0, 1 + (i % 4)).map((t, k) => ({ id: `d${i}-${k}`, districtId: `d${i}`, t, tone: k === 2 ? 'late' : k === 1 ? 'mine' : 'normal' }))).concat([
    { id: 'w1', districtId: null, t: 0, tone: 'normal' },
  ]);
const moveTo = (list, id, t) => list.map((e) => (e.id === id ? { ...e, t } : e));

async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 420, height: 280 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}dev/world.html?q=low${query}`);
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 180000 });
  return page;
}
// Evaluated as an expression, as in the other flows.
const world = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.world, ${JSON.stringify(arg ?? null)})`);
const envoyAt = (page, id) =>
  world(
    page,
    (w, id) => {
      const e = w.envoyItems.find((x) => x.id === id);
      return e ? { x: e.obj.position.x, y: e.baseY, z: e.obj.position.z, rot: e.obj.rotation.y, scale: e.obj.scale.x, walking: e.walking } : null;
    },
    id,
  );
const responses = (page) => world(page, (w) => w.diagnostics().responses);
/**
 * Change the data and read the scene in ONE turn of the page: the loop is live, so a separate read
 * would already see the response a few frames in.
 */
const change = (page, a) =>
  world(
    page,
    (w, a) => {
      if (a.envoys) w.setEnvoys(a.envoys);
      if (a.districts) w.setData({ districts: a.districts, achievements: 7 });
      if ('select' in a) w.select(a.select);
      const envoy = (id) => {
        const e = w.envoyItems.find((x) => x.id === id);
        return e ? { x: e.obj.position.x, y: e.baseY, z: e.obj.position.z, rot: e.obj.rotation.y, scale: e.obj.scale.x, walking: e.walking, t: e.t } : null;
      };
      const castle = (id) => {
        const g = w.districtMesh.get(id);
        return { x: g.scale.x, y: g.scale.y, z: g.scale.z };
      };
      return { responses: w.diagnostics().responses, pulses: w.pulses.size, figures: w.envoysGroup.children.length, envoy: a.envoy ? envoy(a.envoy) : null, castle: a.castle ? castle(a.castle) : null, other: a.other ? castle(a.other) : null };
    },
    a,
  );
const rest = (page) => page.waitForFunction(() => window.world.diagnostics().responses === 0, null, { timeout: 180000, polling: 100 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

try {
  const page = await open();

  // 1. A still scene has no responses, and the picture is within the budget of its tier.
  must((await responses(page)) === 0, 'a city opened without a memory of the last visit stands still');
  const d = await world(page, (w) => { w.renderNow(); return w.diagnostics(); });
  const r = read(d);
  must(!r.overCalls && !r.overTriangles, `over the render budget of «${d.quality}»: ${d.calls}/${BUDGET[d.quality].calls} calls, ${d.triangles}/${BUDGET[d.quality].triangles} triangles`);
  must(r.software && /Программная отрисовка/.test(r.notes[0]), 'software rendering is named as such, so its frame time is not taken for evidence');
  step(`сцена в бюджете уровня «${d.quality}»: ${d.calls} из ${BUDGET[d.quality].calls} вызовов, ${d.triangles} из ${BUDGET[d.quality].triangles} треугольников`);

  // 2. The stage of an item changed: its envoy walks along the road and stops exactly where a still scene puts it.
  const from = await envoyAt(page, 'd0-0');
  const anchorFrom = await world(page, (w) => w.screenOf('d0-0'));
  const start = await change(page, { envoys: moveTo(envoys(), 'd0-0', 0.62), envoy: 'd0-0' });
  must(dist(from, start.envoy) < 0.01, 'the envoy starts from where it stood, not from its new place');
  must(start.responses === 1, `only the envoy whose stage changed answers (${start.responses})`);
  // Not the first walking frame: the walk eases in (easeInOutCubic), so there the envoy has barely
  // moved. Wait until it is a real part of the way along the road and still walking.
  await page.waitForFunction(
    ([from, to]) => {
      const e = window.world.envoyItems.find((x) => x.id === 'd0-0');
      const k = (e.t - from) / (to - from);
      return e.walking && k > 0.15 && k < 0.85;
    },
    [0.05, 0.62],
    { timeout: 60000, polling: 50 },
  );
  const mid = await envoyAt(page, 'd0-0');
  const anchorMid = await world(page, (w) => w.screenOf('d0-0'));
  await shot(page, '01-envoy-walks');
  // Input is not blocked while it walks: the camera answers.
  const v0 = await world(page, (w) => w.getView());
  await world(page, (w) => w.nudge('in'));
  await rest(page);
  must((await world(page, (w) => w.getView())).dist < v0.dist, 'the camera moves while an envoy walks');
  const walked = await envoyAt(page, 'd0-0');
  const still = await world(page, (w, list) => { const live = w.live; w.live = false; w.setEnvoys(list); const e = w.envoyItems.find((x) => x.id === 'd0-0'); const out = { x: e.obj.position.x, y: e.baseY, z: e.obj.position.z, rot: e.obj.rotation.y }; w.live = live; return out; }, moveTo(envoys(), 'd0-0', 0.62));
  must(dist(from, mid) > 0.5 && dist(mid, still) > 0.5, `in between the envoy is on the road, not at either end: ${JSON.stringify({ from, mid, still })}`);
  must(Math.hypot(anchorFrom.x - anchorMid.x, anchorFrom.y - anchorMid.y) > 0.5, 'the card over its head follows it');
  must(near(walked.x, still.x) && near(walked.y, still.y) && near(walked.z, still.z) && near(walked.rot, still.rot) && !walked.walking, `the walk ends exactly at the still place: ${JSON.stringify({ walked, still })}`);
  step('этап изменился → гонец идёт по дороге от прежнего места и встаёт ровно туда, где стоял бы без анимации; камера при этом слушается');

  // 3. A new item appears, a closed one leaves.
  const born = await change(page, { envoys: moveTo(envoys(), 'd0-0', 0.62).concat([{ id: 'new1', districtId: 'd1', t: 0.5, tone: 'normal' }]), envoy: 'new1' });
  must(born.envoy.scale < 0.1 && born.responses === 1, `a new envoy grows from nothing; nobody else moves: ${JSON.stringify(born)}`);
  await rest(page);
  must(near((await envoyAt(page, 'new1')).scale, 2.3), 'and ends at its full size exactly');
  const count = await world(page, (w) => w.envoysGroup.children.length);
  const leaving = await change(page, { envoys: moveTo(envoys(), 'd0-0', 0.62) });
  must(leaving.figures === count && leaving.responses === 1, 'the envoy of a closed item is still seen leaving');
  await rest(page);
  must((await world(page, (w) => w.envoysGroup.children.length)) === count - 1 && (await envoyAt(page, 'new1')) === null, 'and is removed from the scene');
  step('новое обращение — гонец появляется; закрытое — уходит; остальные стоят');

  // 4. A castle grows ONLY when the level became higher; the building and the ring end at rest.
  const scaleOf = (id) => world(page, (w, id) => { const g = w.districtMesh.get(id); return { x: g.scale.x, y: g.scale.y, z: g.scale.z, pulses: w.pulses.size }; }, id);
  const lower = await change(page, { districts: districts([4, 4, 3, 5, 2, 4, 1, 3]), castle: 'd0' });
  must(lower.responses === 0 && near(lower.castle.y, 1.4), 'a lower level is rebuilt without any celebration');
  const pressed = await change(page, { districts: districts([4, 4, 3, 5, 2, 4, 2, 3]), castle: 'd6', other: 'd1' });
  must(pressed.responses === 2 && pressed.castle.y < 1.4 && pressed.castle.x > 1.4 && pressed.pulses === 1, `the grown castle is pressed and a ring starts: ${JSON.stringify(pressed)}`);
  must(near(pressed.other.y, 1.4), 'its neighbours do not move');
  await page.waitForFunction(() => [...window.world.pulses].some((p) => p.visible), null, { timeout: 60000, polling: 50 });
  await world(page, (w) => w.setView({ ...w.viewOf('d6'), dist: 260 }));
  await shot(page, '02-castle-grows');
  await rest(page);
  const risen = await scaleOf('d6');
  must(near(risen.x, 1.4) && near(risen.y, 1.4) && near(risen.z, 1.4) && risen.pulses === 0, `the castle ends at its exact size and the ring is gone: ${JSON.stringify(risen)}`);
  step('уровень вырос → замок «встаёт», по плато расходится кольцо, всё кончается ровно в покое; при понижении уровня отклика нет');

  // 5. Selecting a district: the ring settles and ends at its usual size.
  must((await change(page, { select: 'd2' })).responses === 1, 'a selection answers');
  await rest(page);
  const ring = await world(page, (w) => ({ s: w.ring.scale.x, o: w.ring.material.opacity }));
  const base = await world(page, (w) => { w.live = false; w.select(null); w.select('d2'); const s = w.ring.scale.x; w.live = true; return s; });
  must(near(ring.s, base) && near(ring.o, 0.7), `the ring ends at its usual size and opacity: ${JSON.stringify({ ring, base })}`);
  must((await change(page, { select: 'd2' })).responses === 0, 'selecting the same district again does nothing');
  step('выбор района: кольцо «садится» и возвращается к обычному размеру');

  // 6. Reduced motion: no response starts; one that is playing goes straight to rest.
  must((await change(page, { envoys: moveTo(envoys(), 'd0-0', 0.2) })).responses === 1, 'a walk is playing');
  const settled = await world(page, (w) => { w.live = false; w.renderNow(); const e = w.envoyItems.find((x) => x.id === 'd0-0'); return { n: w.diagnostics().responses, walking: e.walking, t: e.t }; });
  must(settled.n === 0 && !settled.walking && near(settled.t, 0.2), `switching motion off settles everything at once: ${JSON.stringify(settled)}`);
  const quiet = await change(page, { envoys: moveTo(envoys(), 'd0-0', 0.9), districts: districts([5, 5, 5, 5, 5, 5, 5, 5]), select: 'd5', envoy: 'd0-0', castle: 'd6' });
  must(quiet.responses === 0, 'with reduced motion nothing is animated');
  must(near(quiet.envoy.t, 0.9) && !quiet.envoy.walking && near(quiet.castle.y, 1.4), 'the envoy is at its new stage at once and the castles stand at their size');
  step('«уменьшить движение»: отклик не запускается, а идущий сразу приходит в покой');
  await page.close();

  // 7. The memory of the last visit: what changed since then is shown after a pause; the rest stands still.
  const seen = { levels: { d0: 4, d1: 4, d6: 1 }, envoys: Object.fromEntries(envoys().filter((e) => e.id !== 'd3-3').map((e) => [e.id, { d: e.districtId, t: e.id === 'd0-0' ? 0.62 : e.t }])) };
  const again = await open(`&hold=1&seen=${encodeURIComponent(JSON.stringify(seen))}`);
  const n = await world(again, (w) => w.diagnostics().responses);
  // d0 grew 4 → 5 (building + ring), d0-0 moved 0.62 → 0.05, d3-3 is new; d1 and d6 are as remembered.
  must(n === 4, `exactly the four changes since the last visit answer, not the whole city (${n})`);
  const wait = await world(again, (w) => { const e = w.envoyItems.find((x) => x.id === 'd0-0'); const g = w.districtMesh.get('d0'); return { t: e.t, grown: g.scale.y, fresh: w.envoyItems.find((x) => x.id === 'd3-3').obj.scale.x }; });
  must(near(wait.t, 0.62) && near(wait.grown, 1.4) && wait.fresh < 0.1, `during the pause the envoy waits where it was seen, the new one is not there yet: ${JSON.stringify(wait)}`);
  await world(again, (w) => w.start());
  await rest(again);
  const after = await world(again, (w) => { const e = w.envoyItems.find((x) => x.id === 'd0-0'); const g = w.districtMesh.get('d0'); return { t: e.t, walking: e.walking, grown: g.scale.y, fresh: w.envoyItems.find((x) => x.id === 'd3-3').obj.scale.x, pulses: w.pulses.size }; });
  must(near(after.t, 0.05) && !after.walking && near(after.grown, 1.4) && near(after.fresh, 2.3) && after.pulses === 0, `everything ends at rest: ${JSON.stringify(after)}`);
  // The picture is a real one, not a flat colour.
  const colours = await again.evaluate(() => {
    const c = document.querySelector('canvas');
    const t = document.createElement('canvas');
    t.width = 64;
    t.height = 36;
    const g = t.getContext('2d');
    window.world.renderNow();
    g.drawImage(c, 0, 0, 64, 36);
    const p = g.getImageData(0, 0, 64, 36).data;
    const set = new Set();
    for (let i = 0; i < p.length; i += 4) set.add(`${p[i] >> 4},${p[i + 1] >> 4},${p[i + 2] >> 4}`);
    return set.size;
  });
  must(colours > 40, `the canvas looks empty (${colours} colours)`);
  await shot(again, '03-since-last-visit');
  step('память прошлого визита: после паузы показано ровно то, что изменилось (рост замка, переход гонца, новый гонец)');
  await again.close();

  must(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  console.log(`\nОтклик 3D-города проверен в браузере (без базы данных) за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
} finally {
  await browser.close();
  await server.close();
}
