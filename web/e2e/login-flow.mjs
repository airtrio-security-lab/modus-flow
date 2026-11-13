/**
 * The Kingdom sign-in screen (Playwright): every demo character signs in and lands on its start
 * page with the rights of its real roles; 390 / 768 / 1440 px without horizontal scrolling; doubled
 * text size; keyboard only; the search in «Все персонажи»; the skippable entrance; and the screen
 * without demo sign-in (production) shows no people. Saves screenshots to SHOTS (default .demo/shots).
 *   npm run demo:login   (needs the demo server: npm run demo:start)
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { signIn } from './sign-in.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? '.demo/shots';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const step = (name) => console.log(`✓ ${name}`);
const fail = (msg) => {
  throw new Error(msg);
};
async function open(viewport, { lite = '1' } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((v) => localStorage.setItem('modus.lite', v), lite);
  await page.goto(BASE);
  await page.locator('.kl-card').first().waitFor();
  return { ctx, page };
}
const overflowX = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

try {
  // 1. Every character: sign in, start page, real roles.
  for (const p of people) {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    await signIn(page, p);
    await page.waitForSelector('.shell');
    const me = await page.evaluate(async () => {
      const t = sessionStorage.getItem('modus.token') ?? localStorage.getItem('modus.token');
      const r = await fetch('/api/v1/me', { headers: t ? { Authorization: `Bearer ${t}` } : {} });
      return r.ok ? r.json() : null;
    });
    const hash = await page.evaluate(() => location.hash);
    const want = p.titleRank === 'king' || p.titleRank === 'regent' ? '#/kingdom' : p.titleRank === 'castle_head' ? `#/castles/${p.castleId}` : '#/';
    if (hash !== want && !(want === '#/' && hash === '')) fail(`${p.name}: start ${hash}, expected ${want}`);
    if (me) {
      const roles = me.memberships?.[0]?.roles ?? [];
      if (p.roles && [...roles].sort().join() !== [...p.roles].sort().join()) fail(`${p.name}: roles ${roles} ≠ card ${p.roles}`);
    }
    if (await page.locator('.error, [role="alert"].notice.error').count()) fail(`${p.name}: error on the start page`);
    step(`${p.name} (${p.gameTitle ?? '—'}) → ${hash || '#/'}${me ? `, roles: ${me.memberships[0].roles.join(', ')}` : ''}`);
    await ctx.close();
  }

  // 2. Widths: no horizontal scrolling, touch targets ≥ 44 px, screenshots.
  for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
    const { ctx, page } = await open({ width: w, height: h });
    await page.waitForTimeout(400);
    if ((await overflowX(page)) > 0) fail(`${w}px: horizontal scrolling`);
    await page.screenshot({ path: `${SHOTS}/login-${w}.png` });
    await page.locator('.kl-card', { hasText: people[2].name }).click();
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('.kl-card, .kl-all, .kl-enter')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.height < 44 || r.width < 44;
      }).length,
    );
    if (small) fail(`${w}px: ${small} targets smaller than 44×44`);
    await page.screenshot({ path: `${SHOTS}/login-${w}-selected.png`, fullPage: true });
    step(`${w} px: no horizontal scroll, targets ≥ 44 px`);
    await ctx.close();
  }

  // 3. Enlarged system text (200 %) on a phone.
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await page.waitForTimeout(200);
    if ((await overflowX(page)) > 0) fail('200 % text: horizontal scrolling');
    await page.screenshot({ path: `${SHOTS}/login-390-text200.png`, fullPage: true });
    step('200 % text at 390 px: no horizontal scroll');
    await ctx.close();
  }

  // 4. Keyboard only: Tab to the characters, arrows choose, Tab to the button, Enter signs in.
  {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.getAttribute('name') === 'persona')) break;
    }
    if (!(await page.evaluate(() => document.activeElement?.getAttribute('name') === 'persona'))) fail('keyboard: characters not reachable');
    await page.keyboard.press('ArrowDown'); // radios: the arrow moves and selects
    const picked = await page.locator('.kl-card[data-selected] .kl-name').textContent();
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement.closest('.kl-card')).boxShadow);
    if (!ring || ring === 'none') fail('keyboard: no visible focus on the card');
    await page.screenshot({ path: `${SHOTS}/login-keyboard.png` });
    let onButton = false;
    for (let i = 0; i < 4 && !onButton; i++) {
      await page.keyboard.press('Tab');
      onButton = await page.evaluate(() => document.activeElement?.classList.contains('kl-enter'));
    }
    if (!onButton) fail('keyboard: «Войти в Королевство» not reachable');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.shell');
    step(`keyboard: Tab → ↓ (${picked}) → Tab → Enter`);
    await ctx.close();
  }

  // 5. «Все персонажи»: search, choose, Escape closes.
  {
    const { ctx, page } = await open({ width: 390, height: 844 });
    await page.getByRole('button', { name: /^Все персонажи/ }).click();
    await page.getByRole('searchbox').fill('склад');
    const n = await page.locator('.kl-all-list button').count();
    if (n < 2) fail(`search «склад»: ${n} results`);
    await page.screenshot({ path: `${SHOTS}/login-all-390.png` });
    await page.keyboard.press('Escape');
    if (await page.locator('dialog.kl-dialog[open]').count()) fail('Escape did not close the dialog');
    const extra = people[people.length - 1];
    await page.getByRole('button', { name: /^Все персонажи/ }).click();
    await page.getByRole('searchbox').fill(extra.name.split(' ')[0]);
    await page.locator('.kl-all-list button', { hasText: extra.name }).click();
    if ((await page.locator('.kl-card[data-selected] .kl-name').textContent()) !== extra.name) fail('dialog choice not selected');
    step(`«Все персонажи»: search finds ${n}, choosing adds the card`);
    await ctx.close();
  }

  // 6. Entrance animation: shown with full graphics and skippable; nothing without a choice.
  {
    const { ctx, page } = await open({ width: 1440, height: 900 }, { lite: '0' });
    await page.getByRole('button', { name: /^Войти в Королевство/ }).click();
    if (!(await page.getByText('Сначала выберите персонажа').count())) fail('no hint without a choice');
    await page.locator('.kl-card').first().click();
    await page.getByRole('button', { name: /^Войти в Королевство/ }).click();
    await page.locator('.kl-gate').waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/login-gate.png` });
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await page.waitForSelector('.shell');
    step(`entrance shown and skipped (${Date.now() - t0} ms to the app)`);
    await ctx.close();
  }

  // 7. Without demo sign-in (production): no people, no fake SSO button.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.route('**/api/v1/demo/personas', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found","message":"Демо-вход выключен"}' }));
    await page.goto(BASE);
    await page.getByText('Вход через корпоративную учётную запись').waitFor();
    if (await page.locator('.kl-card, .kl-enter, .kl-demo').count()) fail('production screen shows characters or DEMO');
    if (await page.getByText(people[0].name).count()) fail('production screen shows a name');
    await page.screenshot({ path: `${SHOTS}/login-production.png` });
    step('without demo sign-in: no characters, no names, SSO not imitated');
    await ctx.close();
  }

  if (errors.length) fail(`page errors: ${errors.join('; ')}`);
  console.log('Kingdom sign-in: all checks passed');
} finally {
  await browser.close();
}
