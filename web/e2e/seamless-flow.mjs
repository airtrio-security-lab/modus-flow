/**
 * Seamless world through the real UI (ADR-0038): a person enters a building from the city, works, and
 * comes back to the place they left — the same camera, the same selected department — by the link,
 * by the browser's «Назад», after a reload; and does NOT come back to a place that is not theirs.
 *
 * Needs a seeded demo database and the demo server:   npm run demo:seamless
 * BASE / PERSONAS point at another server; SHOTS=<dir> saves the pictures.
 * WebGL here is SwiftShader (software): this scenario checks positions, not speed.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const engineer = by('Сервисный инженер');
const storekeeper = by('Кладовщик');

const browser = await chromium.launch();
const gl = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const shot = async (page, name) => {
  if (!SHOTS) return;
  // The picture is taken after the short entrance has ended.
  await page.waitForFunction(() => !document.querySelector('.page[data-arrive]'), null, { timeout: 3000 }).catch(() => undefined);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

async function as(person, fn, { viewport = { width: 1280, height: 800 }, view = '3d', mobile = false, reducedMotion = 'no-preference', lite = '0' } = {}) {
  const ctx = await (view === '3d' ? gl : browser).newContext({ viewport, deviceScaleFactor: 1, reducedMotion, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript(
    ({ v, lite }) => {
      try {
        localStorage.setItem('modus.kingdom.view', v);
        localStorage.setItem('modus.howto.hidden', '1');
        localStorage.setItem('modus.lite', lite);
        localStorage.setItem('modus.w3d.hint', '1');
        localStorage.setItem('modus.w3d.quality', 'low');
      } catch {
        /* storage unavailable */
      }
    },
    { v: view, lite },
  );
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const world = async (page) => {
  await page.locator('.w3d').waitFor({ timeout: 60000 }).catch(async (e) => {
    throw new Error(`3D-город не открылся: ${await page.evaluate(() => `${location.hash} · ${document.querySelector('.page')?.innerText.slice(0, 160)}`)} (${e.message.split('\n')[0]})`);
  });
  await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
};
const viewNow = (page) => page.evaluate(() => window.__world.getView());
const near = (a, b, eps = 0.5) => ['x', 'z', 'dist'].every((k) => Math.abs(a[k] - b[k]) < eps) && Math.abs(a.az - b.az) < 0.01 && Math.abs(a.pol - b.pol) < 0.01;
const fmt = (v) => `x ${v.x.toFixed(1)}, z ${v.z.toFixed(1)}, dist ${v.dist.toFixed(1)}, az ${v.az.toFixed(2)}`;
const stored = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('modus.world.return') ?? 'null'));
const hashIs = (page, re) => page.waitForFunction((src) => new RegExp(src).test(location.hash), re.source, { timeout: 30000 });
const noSideScroll = async (page, what) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  must(over <= 1, `${what}: страница шире экрана на ${over} px`);
};

try {
  // ---- 1. 3D city → the Great Library → back by the link, then by the browser's «Назад» ----
  await as(engineer, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await world(page);
    // The person looks at the centre from their own angle — not the opening view, not a building's close-up.
    const mine = await page.evaluate(() => {
      const w = window.__world;
      const lib = w.viewOf('library');
      w.setView({ x: lib.x + 30, z: lib.z + 45, dist: 520, az: lib.az + 0.5, pol: 1.0 });
      w.renderNow?.();
      return { mine: w.getView(), closeUp: lib, overview: w.overview() };
    });
    must(!near(mine.mine, mine.closeUp) && !near(mine.mine, mine.overview), 'the test view must differ from the close-up and from the opening view');
    await shot(page, '01-before-entering');

    await page.locator('.w3d-plate[data-kind="library"]').click();
    await hashIs(page, /^#\/library/);
    const kept = await stored(page);
    must(kept && kept.from === '#/kingdom' && kept.place === 'library' && near(kept.view, mine.mine), `the place before the flight is kept, not the close-up: ${JSON.stringify(kept)}`);
    must(Object.keys(kept).sort().join() === 'at,from,member,mode,org,place,selected,v,view', `only navigation is stored: ${Object.keys(kept)}`);
    const link = page.getByRole('link', { name: 'Вернуться в Содружество' }).first();
    await link.waitFor();
    must((await link.getAttribute('href')) === '#/kingdom', 'the Library links back to the city');
    must((await page.locator('.world-return').count()) === 0, 'the catalogue has one link back, not two');
    await shot(page, '02-library-with-way-back');
    step('вход в Библиотеку из 3D-города: запомнено место до подлёта');

    await link.click();
    await world(page);
    const back = await viewNow(page);
    must(near(back, mine.mine), `back by the link: expected ${fmt(mine.mine)}, got ${fmt(back)}`);
    must(!near(back, mine.closeUp) && !near(back, mine.overview), 'neither the close-up nor the opening view');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-kind') === 'library', null, { timeout: 5000 });
    await shot(page, '03-back-at-the-library');
    step('«Вернуться в Содружество»: камера там же, фокус на табличке Библиотеки');

    await page.locator('.w3d-plate[data-kind="library"]').click();
    await hashIs(page, /^#\/library/);
    await page.goBack();
    await world(page);
    must(near(await viewNow(page), mine.mine), `back by the browser: expected ${fmt(mine.mine)}, got ${fmt(await viewNow(page))}`);
    step('кнопка браузера «Назад»: то же место');

    // ---- 2. A department: selected, entered, left for a working screen, and back again ----
    const plate = page.locator('.w3d-labels button.w3d-plate').first();
    await plate.click();
    await page.locator('.w3d-cta', { hasText: 'Войти в цитадель' }).waitFor();
    await page.waitForFunction(() => !window.__world.flight, null, { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(2200);
    const atDistrict = await viewNow(page);
    await page.locator('.w3d-cta', { hasText: 'Войти в цитадель' }).click();
    await hashIs(page, /^#\/castles\/[0-9a-f-]{36}/);
    const castle = await page.evaluate(() => location.hash.split('?')[0]);
    const dept = castle.split('/')[2];
    must((await page.locator('.world-return').count()) === 0, 'a department town is part of the world: no link back on it');
    // A working screen opened from the department: an ordinary link of the navigation.
    await page.locator('.rail .nav a[href="#/board"]').click();
    await hashIs(page, /^#\/board/);
    const bar = page.locator('.world-return');
    await bar.waitFor();
    must(/^Вернуться в город отдела «.+»$/.test((await bar.innerText()).replace('←', '').trim()), `the link names the department: ${await bar.innerText()}`);
    must((await bar.getAttribute('href')) === castle, `the link leads to the department: ${await bar.getAttribute('href')}`);
    await shot(page, '04-working-screen-with-way-back');

    // A reload keeps the way back (and the session of this tab).
    await page.reload();
    await page.waitForSelector('.shell');
    await page.locator('.world-return').waitFor();
    must((await page.locator('.world-return').getAttribute('href')) === castle, 'the way back survives a reload');
    await page.locator('.world-return').focus();
    await page.keyboard.press('Enter');
    await hashIs(page, new RegExp(`^#/castles/${dept}`));
    step('отдел → рабочий экран → перезагрузка → «Вернуться в город отдела» с клавиатуры');

    await page.locator('.back-link[href="#/kingdom"]').first().click();
    await world(page);
    must(near(await viewNow(page), atDistrict, 2), `the city opens at the department: expected ${fmt(atDistrict)}, got ${fmt(await viewNow(page))}`);
    await page.locator('.w3d-cta', { hasText: 'Войти в цитадель' }).waitFor({ timeout: 5000 });
    await shot(page, '05-back-at-the-department');
    step('город открывается у выбранного отдела, его карточка снова открыта');

    // ---- 3. What must NOT be restored ----
    const overview = await page.evaluate(() => window.__world.overview());
    // A context of another organization (or of another person on this device).
    await page.evaluate(() => {
      const c = JSON.parse(sessionStorage.getItem('modus.world.return'));
      sessionStorage.setItem('modus.world.return', JSON.stringify({ ...c, org: '00000000-0000-4000-8000-000000000000' }));
    });
    await page.reload();
    await world(page);
    must(near(await viewNow(page), overview, 2), 'a context of another organization is ignored: the opening view');
    must((await page.locator('.w3d-cta', { hasText: 'Войти в цитадель' }).count()) === 0, 'and nothing is selected');
    // A department that no longer exists.
    await page.evaluate(() => window.__world.setView({ ...window.__world.getView(), dist: 600 }));
    await page.evaluate(() => (location.hash = '#/rating'));
    await hashIs(page, /^#\/rating/);
    await page.evaluate(() => {
      const c = JSON.parse(sessionStorage.getItem('modus.world.return'));
      const gone = '99999999-9999-4999-8999-999999999999';
      sessionStorage.setItem('modus.world.return', JSON.stringify({ ...c, selected: gone, from: `#/castles/${gone}/warriors` }));
    });
    await page.reload();
    await page.waitForSelector('.shell');
    await page.locator('.world-return').waitFor();
    must((await page.locator('.world-return').getAttribute('href')) === '#/kingdom', 'a department that is gone is not a place to return to');
    must((await page.locator('.world-return').innerText()).includes('Вернуться в Содружество'), 'the link falls back to the city');
    await page.locator('.world-return').click();
    await world(page);
    must((await page.locator('.w3d-cta', { hasText: 'Войти в цитадель' }).count()) === 0, 'a department that is gone is not selected');
    step('чужая организация и удалённый отдел не восстанавливаются');

    // Signing out forgets the place.
    await page.evaluate(() => (location.hash = '#/me'));
    await hashIs(page, /^#\/me/);
    await page.getByRole('button', { name: 'Сменить сотрудника' }).first().click();
    await page.getByRole('button', { name: new RegExp(storekeeper.name) }).waitFor();
    must((await stored(page)) === null, 'signing out clears the remembered place');
    step('смена сотрудника очищает запомненное место');
  });

  // ---- 4. Reduced motion: no flight, no fade — and still the same place ----
  await as(engineer, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await world(page);
    const mine = await page.evaluate(() => {
      const w = window.__world;
      const a = w.viewOf('archive');
      w.setView({ x: a.x - 20, z: a.z + 60, dist: 480, az: a.az - 0.3, pol: 1.0 });
      return w.getView();
    });
    // Measured inside the page, from the click itself to the new address: no flight in between.
    const ms = await page.evaluate(
      () =>
        new Promise((done) => {
          const t = performance.now();
          window.addEventListener('hashchange', () => done(performance.now() - t), { once: true });
          document.querySelector('.w3d-plate[data-kind="archive"]').click();
        }),
    );
    await hashIs(page, /^#\/library\?hall=archive/);
    must(ms < 400, `with reduced motion the entrance is immediate (${Math.round(ms)} ms)`);
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.page')).animationName);
    must(anim === 'none', `no decorative animation with reduced motion: ${anim}`);
    await page.goBack();
    await world(page);
    must(near(await viewNow(page), mine), `reduced motion: expected ${fmt(mine)}, got ${fmt(await viewNow(page))}; stored ${JSON.stringify(await stored(page))}`);
    step('prefers-reduced-motion: переход мгновенный, место то же');
  }, { reducedMotion: 'reduce' });

  // ---- 5. The schematic city without WebGL, on a phone: the selected department is kept ----
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    const first = page.locator('.realm-list button').first();
    await first.waitFor({ timeout: 30000 });
    must((await page.locator('canvas.w3d-canvas').count()) === 0, 'the schematic city needs no WebGL');
    await first.click();
    must((await first.getAttribute('aria-pressed')) === 'true', 'the department is selected');
    await page.evaluate(() => (location.hash = '#/library'));
    await hashIs(page, /^#\/library/);
    const link = page.getByRole('link', { name: 'Вернуться в Содружество' }).first();
    await link.waitFor();
    await noSideScroll(page, 'Библиотека на телефоне');
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.page')).animationName);
    must(anim === 'none', `the lite mode has no entrance animation: ${anim}`);
    await link.click();
    await page.locator('.realm-list button').first().waitFor({ timeout: 30000 });
    must((await page.locator('.realm-list button').first().getAttribute('aria-pressed')) === 'true', 'the schematic city keeps the selected department');
    await page.evaluate(() => (location.hash = '#/board'));
    await page.locator('.world-return').waitFor();
    await noSideScroll(page, 'рабочий экран со ссылкой назад на телефоне');
    const box = await page.locator('.world-return').boundingBox();
    must(box && box.height >= 44, `the link is a 44 px touch target: ${box?.height}`);
    await shot(page, '06-phone-lite-way-back');
    step('схема без WebGL на телефоне в облегчённом режиме: выбор отдела сохранён, переход мгновенный');
  }, { view: 'city', lite: '1', mobile: true, viewport: { width: 390, height: 844 } });

  must(errors.length === 0, `ошибки страницы: ${errors.join(' | ')}`);
  console.log(`\nБесшовный мир: все проверки пройдены за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
} finally {
  await browser.close();
  await gl.close();
}
