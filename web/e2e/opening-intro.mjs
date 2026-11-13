// Заставка при открытии: играет, пропускается, не повторяется на перезагрузке, молчит в автотестах.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const OUT = new URL('../../docs/demo/intro/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors = [];
try {
  // 1) Automation without the override: no intro, the app is usable at once.
  {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.opening-intro').count(), 0, 'intro must not block automated runs');
    await page.close();
  }
  // 2) Forced: plays on phone and desktop, then «Пропустить» removes it.
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(() => localStorage.setItem('modus.intro', 'force'));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    const intro = page.locator('.opening-intro');
    await intro.waitFor();
    await page.waitForFunction(() => (document.querySelector('.opening-intro-video')?.currentTime ?? 0) > 2, null, { timeout: 15000 });
    await page.screenshot({ path: `${OUT}${name}.png` });
    const skip = page.getByRole('button', { name: 'Пропустить' });
    assert(await skip.evaluate((el) => el === document.activeElement), 'skip is focused');
    const h = await skip.evaluate((el) => el.getBoundingClientRect().height);
    assert(h >= 44, `touch target ${h}px`);
    await skip.click();
    await intro.waitFor({ state: 'detached', timeout: 2000 });
    await ctx.close();
  }
  // 3) Once per tab: a reload in the same session does not replay it; Esc skips.
  {
    const page = await browser.newPage();
    await page.goto(BASE);
    await page.evaluate(() => { sessionStorage.clear(); Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); });
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    await page.evaluate(() => localStorage.setItem('modus.lite', '0'));
    await page.reload();
    await page.locator('.opening-intro').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.opening-intro').waitFor({ state: 'detached', timeout: 2000 });
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.opening-intro').count(), 0, 'no replay on reload');
    // «Облегчённая графика»: no intro in a new tab session either.
    await page.evaluate(() => { sessionStorage.clear(); localStorage.setItem('modus.lite', '1'); });
    await page.reload();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.opening-intro').count(), 0, 'lite graphics skip the intro');
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('✓ intro plays (phone, desktop), skips by button and Esc, once per tab, off in lite and automation');
} finally {
  await browser.close();
}
