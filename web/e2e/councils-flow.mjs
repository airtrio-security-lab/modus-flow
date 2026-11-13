/**
 * «Цивилизации и советы» through the real UI (owner brief 2026-11-11, ADR-0020): the Japanese IT
 * castle with its titles, the small council in the Зал даймё with an agenda, an invitation worded by
 * the reader's title, a cross-department question passed to the Great Round Table, the heads of the
 * Kazakh and Camelot districts called, the decision by its owner, the task, the confirmed result and
 * the castle's growth. Workflow steps that are not about councils (submit, decide, implement) use
 * the same API the screens use; every fact is read back from the screens.
 * Needs a freshly seeded demo database:  npm run demo:councils
 */
import { chromium } from 'playwright';
import { signIn } from './sign-in.mjs';
import { readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const itLead = by('Руководитель ИТ-разработки');
const analyst = by('Системный аналитик');
const dev = by('Разработчик');
const whHead = by('Начальник склада');
const salesHead = by('Руководитель отдела продаж');
const ops = by('Операционный директор');

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function as(person, fn, opts = DESK) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => localStorage.setItem('modus.lite', '0'));
  await page.reload();
  await signIn(page, person);
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
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
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const TITLE = 'Общий сервер печати этикеток для ИТ, склада и продаж';

try {
  // 1–3. The city, the Japanese IT castle, its people with Japanese titles.
  const itId = await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.realm-castle[aria-label*="«ИТ-разработка»"]').click();
    await page.waitForURL(/#\/castles\/[0-9a-f-]{36}/);
    await page.locator('.district-head', { hasText: 'Японский сёгунат' }).waitFor();
    const titles = {};
    for (const card of await page.locator('.staff-card').all()) {
      const text = (await card.textContent()) ?? '';
      for (const n of ['Дмитрий Орлов', 'Арман Жаксыбеков', 'Елена Смирнова', 'Тимофей Ли']) if (text.includes(n)) titles[n] = (await card.locator('.title-chip').textContent())?.trim();
    }
    must(JSON.stringify(titles) === JSON.stringify({ 'Дмитрий Орлов': 'Даймё', 'Елена Смирнова': 'Самурай', 'Арман Жаксыбеков': 'Каро', 'Тимофей Ли': 'Житель сёгуната' }), `titles: ${JSON.stringify(titles)}`);
    return page.url().split('/castles/')[1].split('/')[0];
  });
  step('город → японский замок ИТ: Даймё, Каро, Самурай, Житель сёгуната — звания по функции, не по людям');

  // A technical initiative from the IT district.
  const n = await as(dev, async (page) => {
    const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
    const cat = dir.categories.find((c) => c.name === 'ИТ и инструменты').id;
    return ok(await apiCall(page, 'POST', '/ideas', { kind: 'idea', title: TITLE, problem: 'Этикетки печатают на трёх разных компьютерах, очереди и потерянные задания', proposal: 'Один сервер печати для ИТ, склада и продаж с общей очередью', categoryId: cat, departmentId: itId }), 'submit').item.number;
  });
  step(`Тимофей подал техническую инициативу №${n}`);

  // 4–5. The small council in the Зал даймё: hall on the map → council tab → call with agenda → camera → meeting.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.realm-hall[aria-label*="«ИТ-разработка»"]').click();
    await page.waitForURL(new RegExp(`#/castles/${itId}/council`));
    await page.locator('.scene', { hasText: 'Зал даймё' }).waitFor();
    await page.getByRole('link', { name: 'Созвать Малый совет' }).click();
    await page.waitForURL(/#\/meetings\/new/);
    while (await page.locator('fieldset', { hasText: 'Участники' }).locator('.pick-list input:checked').count()) await page.locator('fieldset', { hasText: 'Участники' }).locator('.pick-list input:checked').first().uncheck();
    for (const who of ['Елена Смирнова', 'Арман Жаксыбеков', 'Тимофей Ли']) await page.locator('fieldset', { hasText: 'Участники' }).locator('label', { hasText: who }).locator('input').check();
    await page.locator('fieldset', { hasText: 'Повестка' }).locator('label', { hasText: TITLE }).locator('input').check();
    await page.getByLabel(/Я согласен\(на\) на запись/).check();
    await page.getByRole('button', { name: 'Созвать заседание' }).click();
    await page.locator('.realm-cinema', { hasText: 'Входим: Зал даймё' }).waitFor();
    await page.waitForURL(/#\/meetings\/[0-9a-f-]{36}$/);
    await page.getByText('Зал даймё — малый совет «ИТ-разработка»').first().waitFor();
    await page.locator('.agenda', { hasText: TITLE }).waitFor();
  });
  step('Даймё созвал Малый совет: камера к Залу даймё, повестка с инициативой, заседание открыто');

  await as(analyst, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    const scroll = page.locator('li.scroll', { hasText: 'Созван малый совет: Зал даймё' }).first();
    await scroll.waitFor();
    const text = (await scroll.textContent()) ?? '';
    must(text.includes('Самурай, вас ожидают в зале совета: Зал даймё замка «ИТ-разработка»'), `invite: ${text.slice(0, 300)}`);
    must(text.includes('Повестка') && text.includes(TITLE), 'agenda in the invitation');
    // 6. The discussion at the small council.
    ok(await apiCall(page, 'POST', `/ideas/${n}/council/entries`, { kind: 'argument_for', body: 'ИТ поддержит один сервер вместо трёх' }), 'argue');
  });
  step('Елена: «Самурай, вас ожидают в зале совета: Зал даймё…», повестка в приглашении; довод в малом совете');

  // 7. A cross-department question goes to the Great Round Table (camera: castle → palace).
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.locator('.council-place', { hasText: 'Вопрос у малого совета: Зал даймё' }).waitFor();
    await page.getByRole('button', { name: 'Передать в Большой совет' }).click();
    await page.getByLabel('Почему нужен Большой совет').selectOption('cross_department');
    await page.getByLabel('Пояснение').fill('Сервер печати нужен ИТ, складу и продажам — решать вместе');
    await page.getByRole('button', { name: 'Передать к Большому Круглому столу' }).click();
    await page.locator('.realm-cinema', { hasText: 'передаётся к Большому Круглому столу' }).waitFor();
    await page.waitForURL(new RegExp(`#/council/${n}$`));
    await page.getByRole('heading', { name: `Большой Круглый стол: обращение №${n}` }).waitFor();
    await page.locator('.council-place', { hasText: 'Передал(а) Дмитрий Орлов' }).waitFor();
    await page.locator('.council-place', { hasText: 'из малого совета «ИТ-разработка» (Зал даймё)' }).waitFor();
  });
  step('Даймё передал межотдельский вопрос: камера от замка к дворцу; видно, кто передал и почему');

  // 8. Representatives of the Kazakh Khanate and Camelot are called and take their seats.
  // Both heads chose their own form of address earlier (Милорд, Миледи): the message respects it.
  for (const [head, label, addr] of [[whHead, 'Хан Казахского ханства', 'Милорд'], [salesHead, 'Леди Камелота', 'Миледи']]) {
    await as(head, async (page) => {
      await page.goto(`${BASE}/#/inbox`);
      const scroll = page.locator('li.scroll', { hasText: 'Вопрос передан к Большому Круглому столу' }).first();
      await scroll.waitFor();
      const text = (await scroll.textContent()) ?? '';
      must(text.includes(`${addr}, вас созывают к Большому Круглому столу: вопрос «${TITLE}» передан из малого совета «ИТ-разработка»`), `${label}: ${text.slice(0, 300)}`);
      ok(await apiCall(page, 'POST', `/ideas/${n}/council/entries`, { kind: 'argument_for', body: `${label}: нам нужна та же очередь печати` }), 'argue great');
    });
  }
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.locator('.scene-great').waitFor();
    const seats = await page.locator('.scene-arrive').count();
    must(seats >= 4, `representatives at the table: ${seats}`);
    const tags = await page.locator('.entry-where').allTextContents();
    must(tags.includes('малый совет') && tags.filter((t) => t === 'Большой совет').length >= 2, `entry places: ${tags}`);
    // 10. The decision of the responsible person (no vote): «внедрять», implementer Тимофей.
    const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
    const timofey = dir.members.find((m) => m.name === dev.name).membershipId;
    ok(await apiCall(page, 'POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale: 'Один сервер печати для трёх подразделений', implementer: timofey }), 'decide');
  });
  step('Хан и Леди призваны к Большому Круглому столу (обращение — их собственный выбор), заняли места; доводы помечены «малый совет» / «Большой совет»; решение — Айгерим');

  // 11–12. Back to the district: the task, then the confirmed result and the castle's growth.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/castles/${itId}/tasks`);
    await page.locator('.kan-col', { hasText: 'Внедряется' }).getByText(`Обращение №${n}`).waitFor();
  });
  // Тимофей is both the author and the implementer, so the maintainer confirms completion (conflict-of-interest rule).
  await as(itLead, async (page) => {
    ok(await apiCall(page, 'POST', `/ideas/${n}/implementation`, { report: 'Сервер печати настроен, очередь общая для трёх подразделений' }), 'implement');
  });
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/castles/${itId}/growth`);
    await page.locator('.district-head', { hasText: 'Уровень 2 · Крепость' }).waitFor();
    await page.locator('.xp-history', { hasText: `Обращение №${n}` }).waitFor();
    await page.goto(`${BASE}/#/castles/${itId}/staff`);
    await page.locator('.staff-card', { hasText: 'Тимофей Ли' }).locator('.title-chip', { hasText: 'Такуми' }).waitFor();
  });
  step('район: задача «Внедряется» → подтверждённый результат +100 XP, «Крепость», Тимофей стал Такуми');

  // Phone: the Great Round Table stays light and readable.
  await as(
    ops,
    async (page) => {
      await page.goto(`${BASE}/#/council/${n}`);
      await page.locator('.scene-great').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      must(overflow <= 0, `horizontal scroll on phone: ${overflow}`);
    },
    PHONE,
  );
  step('телефон: Большой Круглый стол без горизонтальной прокрутки');

  if (errors.length) throw new Error(`ошибки в браузере: ${errors.join('; ')}`);
  console.log(`Сценарий «Цивилизации и советы» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
