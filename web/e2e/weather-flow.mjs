/**
 * «Живой город» through the real UI (ADR-0044): the 3D city moves by itself — cloud shadows cross the
 * land, flocks of birds fly their loops, sunlight hangs in the air — and none of it gets in the way:
 * the camera answers while the weather runs, motion off means a still picture without hanging birds,
 * light graphics drops the layer's blended surfaces, the scene stays inside the budget of its tier.
 *
 * The weather is not data: the scenario never reads a number of the organization from it.
 *
 * Needs a seeded demo database and the demo server:   npm run demo:weather
 * SHOTS=<dir> saves the pictures. WebGL here is SwiftShader (software): nothing below is a speed measurement.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { signIn } from './sign-in.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const person = people.find((p) => p.title === 'Начальник склада') ?? (() => { throw new Error('persona'); })();
// Mirrors web/src/world3d/budget.ts.
const BUDGET = { low: { calls: 220, triangles: 450_000 }, medium: { calls: 220, triangles: 650_000 }, high: { calls: 220, triangles: 950_000 } };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const shot = async (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);
// Evaluated as an expression, so the page's script policy is not relaxed for it.
const world = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__world, ${JSON.stringify(arg ?? null)})`);

async function city(fn, { viewport = { width: 1280, height: 800 }, quality = 'medium', lite = false, reduce = false, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion: reduce ? 'reduce' : 'no-preference', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(
    ({ quality, lite }) => {
      try {
        localStorage.setItem('modus.kingdom.view', '3d');
        localStorage.setItem('modus.howto.hidden', '1');
        localStorage.setItem('modus.w3d.hint', '1');
        localStorage.setItem('modus.lite', lite ? '1' : '0');
        localStorage.setItem('modus.w3d.quality', quality);
      } catch {
        /* storage unavailable */
      }
    },
    { quality, lite },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /shader|WebGL|program/i.test(m.text())) errors.push(m.text().slice(0, 300));
  });
  await page.goto(BASE);
  await signIn(page, person);
  await page.waitForSelector('.shell');
  await page.goto(`${BASE}/#/kingdom`);
  await page.locator('.w3d').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

try {
  // ---- 1. The city lives: with nothing happening to the data, the picture changes ----
  await city(async (page) => {
    must(await world(page, (w) => w.live), 'на обычном устройстве движение включено');
    const a = await world(page, (w) => w.life.snapshot());
    must(a.clouds >= 5 && a.bodies >= 20 && a.birds >= 5 && a.shafts >= 1 && a.puffs >= 1, `слой погоды построен не целиком: ${JSON.stringify(a)}`);
    await page.waitForFunction((t) => window.__world.life.snapshot().t > t + 1.5, a.t, { timeout: 60000, polling: 100 });
    const b = await world(page, (w) => w.life.snapshot());
    must(b.birdsVisible, 'птицы видны, пока движение включено');
    must(far(a.bird, b.bird) > 0.5, `птицы летят: ${JSON.stringify({ a: a.bird, b: b.bird })}`);
    must(Math.hypot(a.shift.x - b.shift.x, a.shift.z - b.shift.z) > 2, 'тени облаков идут по земле');
    must(far(a.cloud, b.cloud) > 2, 'облака плывут по ветру');
    // The weather does not block the hand: the camera answers while it runs.
    const v0 = await world(page, (w) => w.getView());
    await world(page, (w) => w.nudge('in'));
    await page.waitForFunction((d) => window.__world.getView().dist < d - 1, v0.dist, { timeout: 30000, polling: 100 });
    // The haze of light follows the sun of the scene.
    const sun = await page.locator('.w3d-sun').evaluate((el) => ({ angle: el.style.getPropertyValue('--sun'), shown: getComputedStyle(el).display !== 'none', hits: getComputedStyle(el).pointerEvents }));
    must(/^-?\d+deg$/.test(sun.angle) && sun.shown && sun.hits === 'none', `свет в воздухе привязан к солнцу сцены и не ловит нажатия: ${JSON.stringify(sun)}`);
    const turned = await world(page, (w) => { const a = w.sunBearing(); const v = w.getView(); w.setView({ ...v, az: v.az + 1.2 }); w.renderNow(); return [a, w.sunBearing()]; });
    must(Math.abs(turned[0] - turned[1]) > 10, 'при повороте камеры свет поворачивается вместе со сценой');
    // The scene is inside the budget of its tier with the layer on.
    const s = await world(page, (w) => { w.setView(w.viewOf('palace')); w.renderNow(); return w.stats(); });
    must(s.calls <= BUDGET.medium.calls && s.triangles <= BUDGET.medium.triangles, `сцена вышла из бюджета ступени: ${JSON.stringify(s)}`);
    console.log(`        сцена со слоем погоды: ${s.calls} из ${BUDGET.medium.calls} вызовов, ${s.triangles} из ${BUDGET.medium.triangles} треугольников`);
  });
  step('1. город живёт сам: облака и их тени, птицы, свет; камера отвечает; сцена в бюджете ступени');

  // ---- 2. The same time gives the same picture: pictures for docs/demo ----
  await city(async (page) => {
    const at = (t, view) =>
      world(page, (w, a) => { w.live = true; w.clock = a.t; if (a.view) w.setView(a.view === 'home' ? w.getView() : { ...w.viewOf('palace'), ...a.view }); w.renderNow(); return w.life.snapshot(); }, { t, view });
    const one = await at(80, 'home');
    const two = await at(80, 'home');
    must(far(one.bird, two.bird) < 1e-6 && far(one.cloud, two.cloud) < 1e-6 && one.shift.x === two.shift.x, 'одно и то же время даёт одну и ту же картину');
    await shot(page, '01-home-t080');
    await at(140, 'home');
    await shot(page, '02-home-t140');
    await at(60, { dist: 420, az: 0.6, pol: 1.34 });
    await shot(page, '03-low-view-clouds-shafts');
    await at(200, { dist: 230, az: -0.5, pol: 1.16 });
    await shot(page, '04-palace');
  });
  step('2. одно и то же время — одна и та же картина; снимки общего вида, низкого вида и дворца');

  // ---- 3. «Уменьшить движение»: a still picture, no birds hanging in the air ----
  await city(async (page) => {
    must(!(await world(page, (w) => w.live)), 'при «уменьшить движение» движение выключено');
    const a = await world(page, (w) => { w.renderNow(); return w.life.snapshot(); });
    await page.waitForTimeout(1200);
    const b = await world(page, (w) => { w.renderNow(); return w.life.snapshot(); });
    must(a.t === 0 && b.t === 0, 'погода стоит на своей неподвижной картине');
    must(!a.birdsVisible && !b.birdsVisible, 'птицы скрыты: застывшая в воздухе птица хуже, чем её отсутствие');
    must(far(a.cloud, b.cloud) < 1e-6 && a.shift.x === b.shift.x, 'облака и тени не двигаются');
    const anim = await page.locator('.w3d-sun').evaluate((el) => ({ name: getComputedStyle(el).animationName, ms: getComputedStyle(el).animationDuration }));
    must(anim.name === 'none' || anim.ms === '0s', `свет в воздухе не мерцает: ${JSON.stringify(anim)}`);
    await shot(page, '05-reduced-motion');
  }, { reduce: true });
  step('3. «уменьшить движение»: неподвижная картина, птицы скрыты, свет не мерцает');

  // ---- 4. Light graphics: the lowest tier, no blended beams, no light over the picture ----
  await city(async (page) => {
    const a = await world(page, (w) => { w.renderNow(); return { live: w.live, life: w.life.snapshot(), stats: w.stats() }; });
    must(!a.live && a.life.t === 0 && !a.life.birdsVisible, 'в облегчённой графике погода неподвижна');
    must(a.life.bodies === 0 && a.life.shafts === 0 && a.life.puffs === 0 && a.life.clouds >= 5, `на нижней ступени остаются только тени облаков: ${JSON.stringify(a.life)}`);
    must(a.stats.calls <= BUDGET.low.calls && a.stats.triangles <= BUDGET.low.triangles, `нижняя ступень вышла из бюджета: ${JSON.stringify(a.stats)}`);
    must(!(await page.locator('.w3d-sun').count()), 'на нижней ступени света поверх картины нет');
  }, { lite: true, quality: 'low' });
  step('4. облегчённая графика: нижняя ступень — только тени облаков, без тел облаков, лучей, дыма и света поверх; в бюджете');

  // ---- 5. A phone ----
  await city(async (page) => {
    const a = await world(page, (w) => w.life.snapshot());
    await page.waitForFunction((t) => window.__world.life.snapshot().t > t + 1, a.t, { timeout: 60000, polling: 100 });
    must((await world(page, (w) => w.life.snapshot())).birdsVisible, 'на телефоне город тоже живёт');
    await shot(page, '06-phone');
  }, { viewport: { width: 390, height: 844 }, mobile: true });
  step('5. телефон 390 px: город живёт');

  must(!errors.length, `ошибки на странице: ${errors.join('; ')}`);
  console.log(`ГОТОВО: живой город проверен за ${((Date.now() - t0) / 1000).toFixed(1)} с (программный WebGL: это не замер скорости)`);
} catch (e) {
  console.error(`ОШИБКА: ${e.message}`);
  if (errors.length) console.error(`ошибки страницы: ${errors.join('; ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
