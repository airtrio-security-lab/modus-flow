/**
 * Test against a seeded demo server: node web/e2e/russian-city.mjs
 * Uses a demo admin, switches one district to Russia and restores its prior style.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const admin = people.find((p) => p.title === 'Администратор системы');
if (!admin) throw new Error('Missing demo admin persona');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let oldStyle = null;
let dept = null;
async function api(method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch('/api/v1/orgs/modus-demo' + path, {
      method, headers: { authorization: 'Bearer ' + sessionStorage.getItem('modus.token'),
      ...(body ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(path + ': ' + response.status + ' ' + await response.text());
    return response.json();
  }, { method, path, body });
}
try {
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(admin.name) }).click();
  await page.waitForSelector('.shell');
  await page.goto(BASE + '/#/kingdom');
  await page.locator('.realm-castle').first().click();
  await page.waitForURL(/#\/castles\/[0-9a-f-]{36}$/);
  dept = page.url().split('#')[1].split('/')[2];
  oldStyle = (await api('GET', '/castles/' + dept + '/district')).civilization.id;
  await page.getByRole('button', { name: /Сменить стиль/ }).first().click();
  await page.getByRole('radio', { name: /Русское царство/ }).click();
  await page.getByRole('button', { name: 'Выбрать «Русское царство»' }).click();
  await page.locator('.town-canvas img').waitFor();
  const imgOK = await page.locator('.town-canvas img').evaluate((img) =>
    img.complete && img.naturalWidth > 1000);
  if (!imgOK) throw new Error('Russian city asset not loaded');
  if (await page.locator('.town-hotspot').count() !== 8) throw new Error('Expected 8 buildings');
  await page.getByRole('navigation', { name: 'Все здания Русское царство' })
    .getByRole('link', { name: /Боярская дума/ }).click();
  await page.waitForURL(new RegExp('#/castles/' + dept + '/council$'));
  console.log('✓ Russian Tsardom panorama, eight buildings, Boyar Duma route');
} finally {
  if (dept && oldStyle && oldStyle !== 'russia') {
    try { await api('PUT', '/castles/' + dept + '/civilization', { civilization: oldStyle }); }
    catch (err) { console.error('Could not restore demo style:', err); }
  }
  await ctx.close();
  await browser.close();
}
