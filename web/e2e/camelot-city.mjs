/**
 * Camelot panoramic city E2E, using the real seeded demo server and real routes.
 * Run: node web/e2e/camelot-city.mjs
 * BASE and PERSONAS may override defaults.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const personas = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const admin = personas.find((p) => p.title === 'Администратор системы');
if (!admin) throw new Error('Missing demo admin persona');
const browser = await chromium.launch();

async function session(viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(admin.name) }).click();
  await page.waitForSelector('.shell');
  return { ctx, page, errors };
}

try {
  const { ctx, page, errors } = await session({ width: 1440, height: 950 });
  await page.goto(BASE + '/#/kingdom');
  await page.locator('.realm-castle[aria-label*="Камелот"]').first().click();
  await page.waitForURL(/#\/castles\/[0-9a-f-]{36}$/);
  const entry = page.url().split('#')[1];
  const districtId = entry.split('/')[2];
  await page.locator('.town-canvas img').waitFor();
  const loaded = await page.locator('.town-canvas img').evaluate((img) =>
    img.complete && img.naturalWidth > 1000 && img.naturalHeight > 700);
  if (!loaded) throw new Error('Camelot panorama asset did not load');
  const hotspots = page.locator('.town-hotspot');
  if (await hotspots.count() !== 8) throw new Error('Expected exactly eight interactive landmarks');

  const routes = [
    ['Зал воинов', 'warriors'], ['Зал Совета', 'council'],
    ['Гильдия', 'staff'], ['Мастерские', 'tasks'],
    ['Площадь инициатив', 'initiatives'], ['Цитадель', 'growth'],
    ['Великая библиотека', 'legacy'],
  ];
  for (const [name, tab] of routes) {
    await page.goto(BASE + '/#' + entry + '/city');
    await page.locator('.town-hotspot').filter({ hasText: name }).click();
    await page.waitForURL(new RegExp('#/castles/' + districtId + '/' + tab + '$'));
    await page.locator('.district-tabs').waitFor();
  }
  await page.goto(BASE + '/#' + entry + '/city');
  await page.getByRole('navigation', { name: 'Все здания Камелота' }).getByRole('link', { name: /Высший Архив/ }).click();
  await page.waitForURL(/#\/library\?hall=archive$/);
  if (errors.length) throw new Error('Page errors: ' + errors.join(', '));
  await ctx.close();
  console.log('✓ Desktop: panorama loads, 8 landmarks, real department routes, archive');

  const mobile = await session({ width: 390, height: 844 });
  await mobile.page.goto(BASE + '/#' + entry + '/city');
  await mobile.page.locator('.town-canvas img').waitFor();
  const overflow = await mobile.page.locator('.town-scroll').evaluate((el) => el.scrollWidth > el.clientWidth);
  if (!overflow) throw new Error('Mobile panorama should allow horizontal panning');
  await mobile.page.getByRole('navigation', { name: 'Все здания Камелота' }).getByRole('link', { name: /Зал воинов/ }).click();
  await mobile.page.waitForURL(/\/warriors$/);
  await mobile.page.getByRole('heading', { name: /Зал воинов/ }).waitFor();
  if (mobile.errors.length) throw new Error('Mobile page errors: ' + mobile.errors.join(', '));
  await mobile.ctx.close();
  console.log('✓ Mobile: panorama pans, keyboard-equivalent shortcut reaches Warrior Hall');
} finally {
  await browser.close();
}
