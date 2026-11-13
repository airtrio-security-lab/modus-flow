import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
const errors = [];
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
page.on('pageerror', e => errors.push(e.message));
try {
  await page.addInitScript(() => { localStorage.setItem('modus.kingdom.view', '3d'); localStorage.setItem('modus.w3d.quality', 'low'); localStorage.setItem('modus.w3d.hint', '1'); });
  await page.goto(process.env.BASE ?? 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: /Ерлан Касымов/ }).click();
  await page.locator('.shell').waitFor();
  let expected;
  for (const width of [375, 565, 768, 880, 1024, 1440]) {
  await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
  for (const hash of ['#/', '#/council', '#/me', '#/kingdom']) {
    await page.evaluate(hash => { location.hash = hash; }, hash);
    if (hash === '#/kingdom') await page.locator('.w3d-top').waitFor({ timeout: 60000 });
    else await page.locator('h1').waitFor();
    await page.waitForFunction(() => !document.querySelector('.skeleton, .w3d-loading'));
    const dock = page.locator('.tabbar');
    if (width <= 900 || hash === '#/kingdom') {
    assert(await dock.isVisible(), `${width} ${hash}: shared dock is hidden`);
    const links = await dock.locator(':scope > a').evaluateAll(xs => xs.map(x => x.getAttribute('href')));
    expected ??= links;
    assert.deepEqual(links, expected, `${hash}: destinations changed`);
    assert.equal(await dock.locator('[aria-current="page"]').count(), 1, `${hash}: one active destination`);
    assert.equal(await dock.locator('svg').count(), 5, `${hash}: themed icons`);
    const hit = await dock.evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 10, r.y + r.height / 2));
    });
    assert(hit, `${hash}: dock obscured by the city`);
    if (hash === '#/kingdom' && width <= 900) {
      const controls = await page.locator('.w3d-controls').boundingBox();
      const stats = await page.locator('.w3d-stats').boundingBox();
      assert(controls.y + controls.height <= stats.y, `${width}: camera controls overlap stats`);
    }
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${hash}: horizontal overflow`);
    if (shots && [375, 565, 1440].includes(width)) await page.screenshot({ path: `${shots}/${width}-${hash.slice(2) || 'appeals'}.png` });
  }
  console.log(`✓ ${width}px: city, appeals, council, profile`);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  const camera = await page.locator('.w3d-controls').boundingBox();
  assert(camera.y >= 65, 'Landscape: camera controls overlap header');
  if (shots) await page.screenshot({ path: `${shots}/landscape-kingdom.png` });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.w3d-top summary[aria-label="Все разделы"]').click();
  await page.locator('.w3d-top .section-menu nav a[href="#/library"]').click();
  await page.locator('.gc').waitFor();
  assert(await page.locator('.tabbar').isVisible());
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Library: horizontal overflow');
  const summary = page.locator('.mobile-head summary[aria-label="Все разделы"]');
  await summary.click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.mobile-head .section-menu').getAttribute('open'), null, 'Escape closes menu');
  await page.locator('.tabbar a[href="#/new"]').click();
  await page.locator('h1').waitFor();
  assert.equal(await page.locator('.tabbar a[aria-current="page"]').getAttribute('href'), '#/new');
  await page.locator('.tabbar a[href="#/"]').click();
  await page.locator('.experience-hero').waitFor();
  assert.equal(await page.locator('.tabbar a[aria-current="page"]').getAttribute('href'), '#/');
  await page.evaluate(() => window.scrollTo(0, 350));
  await page.locator('.tabbar a[href="#/council"]').click();
  await page.waitForFunction(() => scrollY === 0);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    for (const hash of ['#/', '#/council', '#/me']) {
      await page.evaluate(hash => { location.hash = hash; }, hash);
      await page.locator('.experience-hero').waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Light ${width} ${hash}: horizontal overflow`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('✓ shared navigation, active routes, icons, hit testing and overflow');
} finally { await browser.close(); }
