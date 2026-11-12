/**
 * «Королевские послания» through the real UI (ADR-0016), the owner's demo sequence:
 *   1. the King calls the council on a real item → 2. castle heads get personal messages
 *   («Милорд», «Миледи», title) → 3. a participant opens the message → 4. «Войти в Совет» →
 *   5. the round table → 6. reads the item → 7. leaves an argument → 8. the decision owner
 *   decides → 9. participants get the result → 10. after the confirmed implementation the
 *   castle gets XP and the author is told.
 * Needs a freshly seeded demo database and the demo server:   npm run demo:messages
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const king = by('Собственник компании');
const whHead = by('Начальник склада');
const ops = by('Операционный директор');
const itLead = by('Руководитель ИТ-разработки');
const storekeeper = by('Кладовщик');

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const expectText = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

async function as(person, fn, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.setItem('modus.howto.hidden', '1'); } catch {} });
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api/v1/orgs/modus-demo${path}`, {
        method,
        headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body },
  );

try {
  // A real item: the storekeeper raises it; routing gives it to IT (Дмитрий leads, Айгерим decides).
  const n = await as(storekeeper, async (page) => {
    const dir = (await apiCall(page, 'GET', '/directory')).body;
    const it = dir.categories.find((c) => c.name === 'ИТ и инструменты').id;
    const wh = dir.departments.find((d) => d.name === 'Склад и логистика').id;
    const r = await apiCall(page, 'POST', '/ideas', {
      kind: 'idea',
      title: 'Печать этикеток со сканера у ворот',
      problem: 'Этикетку печатаем на отдельном компьютере и несём к паллете — 3–4 минуты на машину',
      proposal: 'Печатать этикетку со сканера на мобильный принтер у ворот',
      categoryId: it,
      departmentId: wh,
    });
    if (r.status !== 201) throw new Error(`item: ${r.status}`);
    return r.body.item.number;
  });

  // 1. The King calls the council from the round table of that item.
  await as(king, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('link', { name: 'Созвать заседание с записью' }).click();
    await page.getByLabel('Когда').fill('2026-11-14T10:00');
    for (const name of ['Олег Киселев', 'Сауле Бекова', 'Тимур Ахметов', 'Айгерим Нурланова']) {
      await page.locator('.pick-list label', { hasText: name }).locator('input').check();
    }
    await page.getByLabel(/Я согласен\(на\) на запись/).check();
    await page.getByRole('button', { name: 'Созвать заседание' }).click();
    await page.waitForURL(/#\/meetings\/[0-9a-f-]{36}$/);
    step(`1. Король созвал Совет по обращению №${n}`);
  });

  // 2–5. Personal messages; Олег opens his, confirms and enters the council.
  await as(by('Руководитель отдела продаж'), async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await expectText(page, 'Миледи, вас созывают к Большому Круглому столу!');
    step('2. Сауле выбрала обращение «Миледи» — так к ней и обращаются');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    const scroll = page.locator('li.scroll', { hasText: 'Король созывает Совет' }).first();
    await scroll.waitFor();
    const text = await scroll.textContent();
    for (const must of ['Милорд, вас созывают к Большому Круглому столу!', 'Ваше мнение необходимо для принятия решения', 'Ерлан Касымов', `№${n}`, 'Почему вы', 'Что сделать']) {
      if (!text?.includes(must)) throw new Error(`message lacks «${must}»: ${text}`);
    }
    step('2. Олег получил личное послание: «Милорд…», тема, кто созвал, когда, №, почему он, что сделать');
    await scroll.getByRole('button', { name: 'Подтвердить участие' }).click();
    await scroll.getByText('участие подтверждено').waitFor();
    await scroll.getByRole('button', { name: 'Войти в Совет' }).click();
    await page.waitForURL(new RegExp(`#/council/${n}$`));
    step('3–5. открыл послание, подтвердил участие, «Войти в Совет» → круглый стол');
    await expectText(page, 'Предмет обсуждения');
    await expectText(page, 'Этикетку печатаем на отдельном компьютере');
    await page.getByLabel('Ваш довод').fill('Сэкономим около часа в день на приёмке');
    await page.getByRole('button', { name: 'Добавить аргумент' }).click();
    await expectText(page, 'Сэкономим около часа в день на приёмке');
    step('6–7. изучил обращение и оставил аргумент «за»');
  });

  // 8. The decision owner decides; 9. participants receive the result.
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('button', { name: 'Принять решение' }).first().click();
    await page.getByLabel('Почему внедряем').fill('Совет за, риск закрываем запасным принтером');
    const opt = (await page.getByLabel('Кто внедряет').locator('option', { hasText: itLead.name }).first().textContent())?.trim();
    await page.getByLabel('Кто внедряет').selectOption({ label: opt });
    // Wait for the server to record the decision, not only for text on the page (the context closes right after).
    const saved = page.waitForResponse((r) => r.url().endsWith(`/ideas/${n}/decision`) && r.request().method() === 'POST');
    await page.locator('form.council-form button[type=submit]').click();
    if (!(await saved).ok()) throw new Error('decision was not recorded');
    await expectText(page, 'Решение: внедрить');
    step('8. ответственный (Айгерим) принял решение и назначил исполнителя');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await page.locator('li.scroll', { hasText: 'Решение зафиксировано' }).filter({ hasText: 'утверждено: внедрять' }).first().waitFor();
    step('9. участник Совета получил итог: «Милорд, решение … утверждено: внедрять»');
  });
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await page.getByRole('button', { name: 'Решения и поручения' }).click();
    await page.locator('li.scroll', { hasText: 'Получено поручение' }).first().waitFor();
    await page.goto(`${BASE}/#/items/${n}`);
    await page.getByRole('button', { name: 'Отметить как реализовано' }).click();
    await page.getByLabel('Что внедрено').fill('Этикетки печатаются у ворот');
    await page.locator('form.composer').getByRole('button', { name: 'Отметить как реализовано' }).click();
    await expectText(page, 'Реализовано');
    step('исполнитель получил «Получено поручение» и отметил внедрение');
  });
  // 10. The castle gets XP; the author is told — on a phone, readable without zoom.
  await as(
    storekeeper,
    async (page) => {
      await page.goto(`${BASE}/#/inbox`);
      const xp = page.locator('li.scroll', { hasText: 'Замок получил XP' }).first();
      await xp.waitFor();
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390) throw new Error(`horizontal scroll on the phone: ${width}px`);
      const font = await xp.locator('.scroll-business').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      if (font < 14) throw new Error(`text too small on the phone: ${font}px`);
      step('10. замок получил XP — автору пришло послание; на телефоне читается без увеличения');
    },
    { width: 390, height: 844 },
  );

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`Сценарий «Королевские послания» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} finally {
  await browser.close();
}
