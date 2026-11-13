/**
 * Reproducible performance profile of the city (ADR-0039): the same route on every graphics mode —
 * 3D high / medium («balanced») / low («lite»), and the schematic SVG city without WebGL.
 *
 *   npm run demo:perf                       # the browser picks the renderer it has
 *   GPU=software npm run demo:perf          # SwiftShader: counts are valid, frame times are NOT a device's
 *   OUT=docs/audit/perf.json LABEL=after npm run demo:perf
 *   THROTTLE=6 npm run demo:perf            # the processor slowed down 6× (an emulation; the video card is not)
 *
 * What is measured, per mode:
 *   start      — sign-in click → the application shell is on the screen
 *   map        — opening «Город» → the map answers input (3D: engine ready and first frame; scheme: castles drawn)
 *   fps / p95  — frame times while the camera orbits for SECONDS seconds (3D), or while the map is panned (scheme)
 *   calls / triangles — what the renderer drew in the last frame (three.js `renderer.info`)
 *   heap       — JS heap after the orbit (CDP `Performance.getMetrics`); GPU memory is not visible to a page
 *   cpu        — share of one core the page's main thread was busy during the orbit (CDP TaskDuration)
 *   toLibrary / toMap — map → the Great Library → back, until each screen is usable
 *
 * The renderer string is printed with every run. A software renderer is marked, and its frame times
 * must not be quoted as the speed of a real video card. GPU load is not available from a browser.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const OUT = process.env.OUT ?? null;
const LABEL = process.env.LABEL ?? 'run';
const SECONDS = Number(process.env.SECONDS ?? 6);
const GPU = process.env.GPU ?? 'auto';
/** CPU slowdown through the DevTools protocol (4 ≈ a mid-range phone, 6 ≈ a weak one). An emulation of a slow processor, not a measurement of a real weak computer; the video card is not slowed down. */
const THROTTLE = Number(process.env.THROTTLE ?? 1);
const VIEWPORT = { width: Number(process.env.W ?? 1366), height: Number(process.env.H ?? 768) };
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const person = people.find((p) => p.title === 'Сервисный инженер') ?? people[0];

const ARGS = {
  software: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  hardware: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])],
  auto: [],
};
const browser = await chromium.launch({ args: [...(ARGS[GPU] ?? []), '--enable-precise-memory-info'] });

const MODES = [
  { id: 'high', title: '3D · высокое', view: '3d', quality: 'high', lite: '0' },
  { id: 'medium', title: '3D · сбалансированное', view: '3d', quality: 'medium', lite: '0' },
  { id: 'low', title: '3D · облегчённое', view: '3d', quality: 'low', lite: '1' },
  { id: 'scheme', title: 'Схема (SVG, без WebGL)', view: 'city', quality: 'low', lite: '1' },
];
const only = process.env.MODES ? process.env.MODES.split(',') : null;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

async function profile(mode) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ view, quality, lite }) => {
    try {
      localStorage.setItem('modus.kingdom.view', view);
      localStorage.setItem('modus.w3d.quality', quality);
      localStorage.setItem('modus.lite', lite);
      localStorage.setItem('modus.howto.hidden', '1');
      localStorage.setItem('modus.w3d.hint', '1');
    } catch {
      /* storage unavailable */
    }
  }, mode);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const r = { mode: mode.id, title: mode.title };
  try {
    await page.goto(BASE);
    const button = page.getByRole('button', { name: new RegExp(person.name) });
    await button.waitFor();
    let t = Date.now();
    await button.click();
    await page.waitForSelector('.shell');
    r.startMs = Date.now() - t;

    const is3d = mode.view === '3d';
    const mapReady = async () => {
      if (is3d) {
        await page.waitForFunction(() => window.__world && !document.querySelector('.w3d-loading'), null, { timeout: 180000 });
        // One frame really drawn after the engine reported ready.
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      } else await page.locator('.realm-list button').first().waitFor({ timeout: 60000 });
    };
    t = Date.now();
    await page.evaluate(() => (location.hash = '#/kingdom'));
    await mapReady();
    r.mapMs = Date.now() - t;

    if (is3d) r.gpu = await page.evaluate(() => window.__world.diagnostics().gpu);
    else r.gpu = 'WebGL не используется';

    const before = await metrics();
    const t0 = Date.now();
    const frames = await page.evaluate(
      ({ seconds, is3d }) =>
        new Promise((done) => {
          const out = [];
          const w = window.__world;
          const start = performance.now();
          let last = start;
          const base = is3d ? w.getView() : null;
          const svg = document.querySelector('svg[class*="realm"]') ?? document.querySelector('main svg');
          const step = (now) => {
            out.push(now - last);
            last = now;
            const k = (now - start) / 1000;
            if (is3d) w.setView({ ...base, az: base.az + k * 0.5, dist: base.dist * (1 - 0.18 * Math.sin(k * 1.3)) });
            // The scheme: a pan gesture of the same length, through the map's own wheel handler.
            else svg?.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sin(k * 3) * 40, clientX: 600, clientY: 380, bubbles: true, cancelable: true }));
            if (now - start < seconds * 1000) requestAnimationFrame(step);
            else {
              if (is3d) w.setView(base);
              done(out.slice(1));
            }
          };
          requestAnimationFrame(step);
        }),
      { seconds: SECONDS, is3d },
    );
    const after = await metrics();
    const wall = (Date.now() - t0) / 1000;
    const sorted = [...frames].sort((a, b) => a - b);
    const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
    r.frames = frames.length;
    r.fps = round(1000 / mean);
    r.medianMs = round(pct(sorted, 0.5));
    r.p95Ms = round(pct(sorted, 0.95));
    r.worstMs = round(sorted.at(-1));
    r.cpu = round(((after.TaskDuration - before.TaskDuration) / wall) * 100, 0);
    r.heapMb = round(after.JSHeapUsedSize / 1048576);
    if (is3d) {
      const s = await page.evaluate(() => window.__world.stats());
      r.calls = s.calls;
      r.triangles = s.triangles;
      r.dpr = s.dpr;
    }

    // Map → the Great Library → back.
    t = Date.now();
    await page.evaluate(() => (location.hash = '#/library'));
    await page.getByRole('link', { name: 'Вернуться в Содружество' }).first().waitFor({ timeout: 60000 });
    r.toLibraryMs = Date.now() - t;
    t = Date.now();
    await page.evaluate(() => (location.hash = '#/kingdom'));
    await mapReady();
    r.toMapMs = Date.now() - t;
  } finally {
    await ctx.close();
  }
  return r;
}

const rows = [];
for (const mode of MODES) {
  if (only && !only.includes(mode.id)) continue;
  const r = await profile(mode);
  rows.push(r);
  console.log(
    `${r.title.padEnd(28)} старт ${String(r.startMs).padStart(5)} мс · карта ${String(r.mapMs).padStart(5)} мс · ${String(r.fps).padStart(5)} к/с · p95 ${String(r.p95Ms).padStart(6)} мс · ` +
      `${r.calls ?? '—'} вызовов · ${r.triangles ?? '—'} треуг. · куча ${r.heapMb} МБ · ЦП ${r.cpu}% · → библиотека ${r.toLibraryMs} мс · → карта ${r.toMapMs} мс`,
  );
}
await browser.close();

const gpu = rows.find((r) => r.calls != null)?.gpu ?? '';
const software = /swiftshader|llvmpipe|software|basic render/i.test(gpu);
console.log(`\nОтрисовка: ${gpu || 'нет данных'}${software ? ' — ПРОГРАММНАЯ: время кадра и к/с здесь не показатель реальной видеокарты.' : ''}`);
console.log(`Экран ${VIEWPORT.width}×${VIEWPORT.height}, DPR 1, облёт ${SECONDS} с${THROTTLE > 1 ? `, процессор замедлен в ${THROTTLE} раз (эмуляция, не реальный слабый компьютер)` : ''}. Загрузка видеокарты из браузера не видна.`);
if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  let all = {};
  try {
    all = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    /* first run */
  }
  all[LABEL] = { at: new Date().toISOString(), base: BASE.replace(/\/\/[^/]+/, '//local'), viewport: VIEWPORT, seconds: SECONDS, cpuThrottle: THROTTLE, renderer: gpu, software, platform: `${process.platform} ${process.arch}`, rows };
  writeFileSync(OUT, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`Записано: ${OUT} [${LABEL}]`);
}
