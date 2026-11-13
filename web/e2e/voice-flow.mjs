/**
 * «Спросить советника» through the real UI (ADR-0042), in the configuration of the demo by default:
 * the voice provider is NOT connected (no paid API without the owner's decision). Checked:
 *  - the floating button opens the panel; it honestly says «Голосовой AI не подключён» and offers text;
 *  - a typed question is answered from MODUS FLOW data (facts and links), labelled when no model is connected;
 *  - the links lead to real items; the round table has its own «Спросить советника» button;
 *  - on a phone the button and the panel leave the tab bar free; nothing scrolls sideways;
 *  - closing the panel releases everything (no microphone request was made at all).
 * With a voice provider configured (MODUS_VOICE_PROVIDER=openai …) the scenario only checks that the
 * talk mode is offered; a live conversation needs a microphone and a person and is checked by hand.
 *   BASE=http://localhost:3100 node web/e2e/voice-flow.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { signIn } from './sign-in.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const OUT = process.env.SHOTS ?? 'docs/demo/voice-advisor';
mkdirSync(OUT, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const whHead = people.find((p) => p.title === 'Начальник склада') ?? people[0];

const browser = await chromium.launch();
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const fail = (m) => {
  throw new Error(m);
};

async function as(viewport, fn) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  let micAsked = false;
  await page.exposeFunction('__micAsked', () => (micAsked = true));
  await page.addInitScript(() => {
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => {
        window.__micAsked();
        return orig(c);
      };
    }
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE);
  await signIn(page, whHead);
  await page.waitForSelector('.shell');
  try {
    return await fn(page, () => micAsked);
  } finally {
    await ctx.close();
  }
}

// ---- desktop ---------------------------------------------------------------
await as({ width: 1280, height: 860 }, async (page, micAsked) => {
  const status = await page.evaluate(async () => {
    const token = sessionStorage.getItem('modus.token');
    const me = await (await fetch('/api/v1/me', { headers: { authorization: `Bearer ${token}` } })).json();
    const org = me.memberships[0].organization;
    return (await fetch(`/api/v1/orgs/${org}/voice/status`, { headers: { authorization: `Bearer ${token}` } })).json();
  });
  const fab = page.getByRole('button', { name: 'Спросить советника' });
  await fab.waitFor();
  step('плавающая кнопка «Спросить советника» на экране');
  await fab.click();
  const panel = page.getByRole('dialog', { name: 'Советник' });
  await panel.waitFor();
  const box = await panel.boundingBox();
  if (!box || box.width > 420 || box.x < 800) fail(`на десктопе — боковая панель справа, а не ${JSON.stringify(box)}`);
  step('открылась боковая панель');

  if (!status.voice.configured) {
    await page.getByRole('tab', { name: 'Поговорить' }).click();
    await panel.getByText('Голосовой AI не подключён').waitFor();
    if (await panel.getByRole('button', { name: /Начать разговор/ }).count()) fail('кнопка разговора без подключённого голоса');
    step('честно: «Голосовой AI не подключён», имитации разговора нет');
    await page.screenshot({ path: `${OUT}/01-not-connected.png` });
    await panel.getByRole('button', { name: 'Спросить текстом' }).click();
  } else {
    await panel.getByRole('button', { name: /Начать разговор/ }).waitFor();
    step(`голос подключён (${status.voice.provider}): режим «Поговорить» доступен — живой разговор проверяется вручную`);
    await page.getByRole('tab', { name: 'Текстом' }).click();
  }

  await panel.getByLabel(/Вопрос о ваших задачах/).fill('Что сегодня требует моего внимания?');
  await panel.getByRole('button', { name: 'Спросить' }).click();
  await panel.getByRole('navigation', { name: 'Найденные записи' }).waitFor({ timeout: 15000 });
  const links = await panel.locator('.va-refs a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  if (!links.length || !links.every((h) => /^#\/(items|council|meetings)\//.test(h))) fail(`ссылки: ${links}`);
  if (!status.text.configured) await panel.getByText(/без пересказа/).first().waitFor();
  step(`текстовый вопрос: ${links.length} ссылок на записи MODUS FLOW${status.text.configured ? '' : ', с пометкой «без пересказа ИИ»'}`);

  await panel.getByLabel(/Вопрос о ваших задачах/).fill('Найди обращения про космодром на Луне');
  await panel.getByRole('button', { name: 'Спросить' }).click();
  await panel.getByText(/ничего не нашлось|не нашлось/).first().waitFor({ timeout: 15000 });
  step('нет данных — так и сказано');
  await page.screenshot({ path: `${OUT}/02-text-answer.png` });

  const first = links.find((h) => h.startsWith('#/items/')) ?? links[0];
  await panel.locator(`.va-refs a[href="${first}"]`).click();
  await page.waitForFunction((h) => location.hash === h, first);
  step(`ссылка открывает запись ${first}`);

  await page.getByRole('button', { name: /Закрыть панель советника/ }).click();
  await fab.waitFor();
  if (micAsked()) fail('микрофон запрашивался без разговора');
  step('панель закрыта; микрофон ни разу не запрашивался');

  await page.goto(`${BASE}/#/council`);
  const row = page.locator('a[href^="#/council/"]').first();
  await row.waitFor();
  const href = await row.getAttribute('href');
  await page.goto(`${BASE}/${href}`);
  const tableBtn = page.getByRole('button', { name: /Спросить советника о вопросе №/ });
  await tableBtn.waitFor();
  await tableBtn.click();
  await panel.getByText(/За круглым столом · вопрос №/).waitFor();
  step(`за круглым столом ${href}: советник открывается с контекстом вопроса`);
  await page.screenshot({ path: `${OUT}/03-round-table.png` });
});

// ---- phone -----------------------------------------------------------------
await as({ width: 375, height: 812 }, async (page) => {
  const fab = page.getByRole('button', { name: 'Спросить советника' });
  await fab.waitFor();
  const tab = await page.locator('.tabbar').boundingBox();
  const fb = await fab.boundingBox();
  if (!tab || !fb || fb.y + fb.height > tab.y) fail(`кнопка перекрывает нижнюю панель: ${JSON.stringify({ fb, tab })}`);
  if (fb.height < 44) fail('цель касания меньше 44 px');
  await fab.click();
  const panel = page.getByRole('dialog', { name: 'Советник' });
  await panel.waitFor();
  // The sheet may run under the tab bar, but every tab must stay on top and clickable.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll('.tabbar a')].filter((a) => {
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !hit || !a.contains(hit);
    }).length,
  );
  if (covered) fail(`нижний лист закрывает ${covered} кнопок панели разделов`);
  const input = await panel.getByLabel(/Вопрос о ваших задачах/).boundingBox();
  if (!input || input.y + input.height > tab.y) fail('поле вопроса уходит под панель разделов');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (wide) fail('горизонтальная прокрутка на телефоне');
  await page.locator('.tabbar a').first().click();
  step('телефон: кнопка и нижний лист не закрывают панель разделов, разделы нажимаются');
  await page.screenshot({ path: `${OUT}/04-phone.png` });
});

await browser.close();
if (errors.length) {
  console.error('Ошибки на странице:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с. Снимки: ${OUT}/`);
