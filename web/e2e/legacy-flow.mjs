/**
 * «Наследие Королевства» through the real UI (ADR-0017), the owner's demo chain:
 *   meeting → registration in the Chronicle → council decision → confirmed result →
 *   Library card → re-application of the method → approval into the Higher Archive.
 * Every level change is a button pressed by the person with the right role; the archive
 * animation plays only after the server confirmed the approval.
 * Setup steps that other scenarios already cover in the UI (submitting items, consent,
 * the decision and the implementation report) go through the same public API.
 * Needs a freshly seeded demo database and the demo server:   npm run demo:legacy
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const king = by('Собственник компании');
const whHead = by('Начальник склада');
const storekeeper = by('Кладовщик');
const engineer = by('Сервисный инженер');
const archivist = by('Архивариус');

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const expectText = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });
const shot = async (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

async function as(person, fn, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.setItem('modus.howto.hidden', '1'); localStorage.setItem('modus.lite', '0'); } catch {} });
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
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
/** Presses an action button, writes the reason and confirms. */
async function act(page, label, reason) {
  await page.getByRole('button', { name: label, exact: true }).click();
  if (reason) await page.locator('#act-reason').fill(reason);
  await page.locator('.k-confirm').getByRole('button', { name: label, exact: true }).click();
  await page.locator('.k-confirm').waitFor({ state: 'detached' });
}

const MINUTES = `Письменный протокол планёрки склада (без записи).
Асель Темирова: машины стоят у ворот по сорок минут, потому что этикетки печатают на одном компьютере в конторе склада.
Руслан Исаев: можно печатать со сканера на мобильный принтер прямо у ворот.
Олег Киселев: согласен на пилот у ворот номер один, если будет запасной принтер.`;

try {
  // ---- 1. The meeting: a real item, everyone's own consent, written minutes ----
  const { n, wh } = await as(storekeeper, async (page) => {
    const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
    const wh = { cat: dir.categories.find((c) => c.name === 'Склад и логистика').id, dep: dir.departments.find((d) => d.name === 'Склад и логистика').id };
    const r = ok(
      await apiCall(page, 'POST', '/ideas', {
        kind: 'problem',
        title: 'Машины ждут приёмки из-за печати этикеток',
        problem: 'Этикетки печатают на одном компьютере в конторе, машины стоят у ворот около 40 минут',
        categoryId: wh.cat,
        departmentId: wh.dep,
      }),
      'item',
    );
    return { n: r.item.number, wh };
  });
  const mid = await as(whHead, async (page) => {
    const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
    const id = (name) => dir.members.find((m) => m.name === name).membershipId;
    return ok(
      await apiCall(page, 'POST', '/meetings', { title: 'Планёрка: этикетки у ворот', ideaNumber: n, participants: [id(storekeeper.name), id(engineer.name)], organizerConsent: true }),
      'meeting',
    ).id;
  });
  for (const p of [storekeeper, engineer]) await as(p, async (page) => ok(await apiCall(page, 'POST', `/meetings/${mid}/consent`, { consent: 'given' }), 'consent'));
  await as(whHead, async (page) => ok(await apiCall(page, 'POST', `/meetings/${mid}/transcripts`, { text: MINUTES, source: 'minutes' }), 'minutes'));
  step(`1. совещание: обращение №${n}, заседание с согласием каждого, письменный протокол`);

  // ---- 2. Registration in the Chronicle from the meeting page ----
  const kid = await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/meetings/${mid}`);
    await page.getByRole('link', { name: 'Внести итог в Летопись' }).click();
    await page.getByLabel('Название').waitFor();
    await expectText(page, 'Черновик собран из полей обращения');
    await page.getByLabel('Название').fill('Печать этикеток у ворот приёмки');
    await page.getByLabel('Вид знания').selectOption('method');
    // A passage pasted from the meeting minutes is refused: knowledge must not outlive the minutes' retention.
    await page.getByLabel('Исходная проблема').fill('Машины стоят у ворот по сорок минут, потому что этикетки печатают на одном компьютере в конторе склада.');
    await page.getByRole('button', { name: 'Внести в Летопись' }).click();
    await expectText(page, 'фрагмент расшифровки заседания');
    await shot(page, '01-copy-guard');
    await page.getByLabel('Исходная проблема').fill('Машины ждали приёмки около 40 минут: этикетки печатались только в конторе.');
    await page.getByLabel('Рассмотренные варианты').fill('Печать в конторе; мобильный принтер у ворот; предварительная печать по заявке поставщика.');
    await page.getByLabel('Аргументы за').fill('Дешёвый принтер, этикетка печатается там, где товар.');
    await page.getByLabel('Аргументы против').fill('Поломка единственного принтера остановит приёмку.');
    await page.getByLabel('Принятое решение').fill('Печатать этикетку со сканера на мобильный принтер у ворот, держать запасной принтер.');
    await page.getByLabel('Причины выбора').fill('Самый быстрый вариант при низкой цене; риск закрыт запасным принтером.');
    await page.getByRole('button', { name: 'Внести в Летопись' }).click();
    await page.waitForURL(/#\/library\/[0-9a-f-]{36}$/);
    await expectText(page, 'зарегистрировано, не проверено');
    await expectText(page, 'Заседание «Планёрка: этикетки у ворот»');
    await shot(page, '02-chronicle');
    return page.url().split('/').pop();
  });
  step('2. регистрация в Летописи: вставка из протокола отклонена, пересказ принят, источники — обращение и заседание');

  // ---- 3–4. The council decides; the result is confirmed ----
  await as(whHead, async (page) => {
    ok(await apiCall(page, 'POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale: 'Пилот у ворот №1 с запасным принтером', implementer: (await apiCall(page, 'GET', '/directory')).body.members.find((m) => m.name === engineer.name).membershipId }), 'decide');
  });
  await as(engineer, async (page) => ok(await apiCall(page, 'POST', `/ideas/${n}/implementation`, { report: 'Принтер у ворот №1 работает: приёмка машины — 12 минут вместо 40' }), 'complete'));
  step('3–4. решение «внедрять» и отчёт о внедрении (подтверждённый результат)');

  // ---- 5. Library card: proposed by the head, checked by the archivist ----
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/library/${kid}`);
    await act(page, 'Предложить в Библиотеку', 'Решение принято и внедрено, результат известен');
    await expectText(page, 'ждёт проверки Архивариусом');
    // The meeting is closed: the archivist cannot see the entry until an approver opens the retold card.
    await act(page, 'Открыть всей организации', 'Карточка пересказана, протокол заседания не перенесён');
  });
  await as(archivist, async (page) => {
    await page.goto(`${BASE}/#/library`);
    await page.getByRole('button', { name: /Летопись/ }).click();
    await page.locator('.volume', { hasText: 'Печать этикеток у ворот приёмки' }).click();
    await expectText(page, 'Закрытое заседание — доступно только участникам');
    await act(page, 'Внести в Библиотеку', 'Проверила отчёт о внедрении и решение');
    await expectText(page, 'проверено Архивариусом');
    await shot(page, '03-library');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await expectText(page, 'Милорд, ваше решение «Печать этикеток у ворот приёмки» внесено в Библиотеку.');
    await page.locator('li.scroll', { hasText: 'Печать этикеток у ворот приёмки» внесено в Библиотеку' }).getByRole('button', { name: 'Открыть в Великой библиотеке' }).click();
    await page.waitForURL(new RegExp(`#/library/${kid}$`));
  });
  step('5. Библиотека: предложено руководителем, проверено Архивариусом; послание «Ваше решение внесено в Библиотеку» ведёт к карточке');

  // ---- 6. The method is applied again on another item ----
  const n2 = await as(storekeeper, async (page) =>
    ok(await apiCall(page, 'POST', '/ideas', { kind: 'idea', title: 'Мобильная печать этикеток у ворот №2', problem: 'У ворот №2 та же очередь из-за печати этикеток в конторе', proposal: 'Повторить метод ворот №1', categoryId: wh.cat, departmentId: wh.dep }), 'item 2').item.number,
  );
  await as(whHead, async (page) => {
    ok(await apiCall(page, 'POST', `/ideas/${n2}/decision`, { outcome: 'merge', rationale: 'Повторяем проверенный метод на воротах №2', implementer: (await apiCall(page, 'GET', '/directory')).body.members.find((m) => m.name === whHead.name).membershipId }), 'decide 2');
    ok(await apiCall(page, 'POST', `/ideas/${n2}/implementation`, { report: 'Ворота №2: приёмка 14 минут' }), 'complete 2');
  });
  await as(archivist, async (page) => {
    await page.goto(`${BASE}/#/library/${kid}`);
    await page.getByLabel('Номер обращения', { exact: true }).fill(String(n2));
    await page.getByLabel('Что применили').fill('Тот же метод на воротах №2');
    await page.getByRole('button', { name: 'Записать применение' }).click();
    await expectText(page, 'внедрено — подтверждено');
    // The conclusion is a new version with a reason.
    await page.getByRole('button', { name: 'Новая версия карточки' }).click();
    await page.getByLabel('Результаты').fill('Приёмка машины: 40 → 12 минут на воротах №1, 14 минут на воротах №2.');
    await page.getByLabel('Положительный опыт').fill('Печать у места приёмки убрала очередь.');
    await page.getByLabel('Отрицательный опыт').fill('Первую неделю без запасного принтера был простой на 20 минут.');
    await page.getByLabel('Категория наследия').selectOption('method');
    await page.getByLabel('Доказанность').fill(`Отчёты о внедрении №${n} и №${n2}, одинаковый результат.`);
    await page.getByLabel('Область применимости').fill('Склады с приёмкой у ворот и сканерами с Bluetooth.');
    await page.getByLabel('Основания включения').fill('Метод воспроизведён на втором участке с тем же эффектом.');
    await page.getByLabel('Дата последней проверки').fill('2026-11-11');
    await page.getByLabel('Причина изменения').fill('Заключение для Высшего Архива');
    await page.getByRole('button', { name: 'Сохранить версию' }).click();
    await expectText(page, 'Версия 2');
    await act(page, 'Представить заключение Совету', 'Метод воспроизведён дважды');
    await expectText(page, 'Заключение Архивариуса ждёт утверждения');
  });
  step(`6. повторное применение на №${n2} (внедрено), заключение — новая версия карточки, представлено Совету`);

  // ---- 7. Approval by the authorized person; the archive moment ----
  await as(king, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await expectText(page, 'Ваше Величество, Архивариус представил новое знание для рассмотрения Советом: «Печать этикеток у ворот приёмки».');
    await page.locator('li.scroll', { hasText: 'Архивариус представил новое знание' }).getByRole('button', { name: 'Открыть в Великой библиотеке' }).click();
    await page.waitForURL(new RegExp(`#/library/${kid}$`));
    await act(page, 'Утвердить включение в Высший Архив', 'Утверждаю: метод доказан');
    await page.locator('.vault').waitFor();
    await page.waitForTimeout(1900);
    await shot(page, '04-vault');
    await page.locator('.vault').click();
    await expectText(page, 'утверждено как наследие');
    await expectText(page, 'Включение в Высший Архив утверждено');
    await shot(page, '05-archive');
  });
  step('7. Высший Архив: утверждено Собственником, анимация после подтверждения, история переходов на месте');

  // ---- Search across halls, the map building, the phone ----
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('link', { name: /Великая библиотека: Летопись/ }).waitFor();
    await shot(page, '08-map');
    await page.getByRole('link', { name: /Великая библиотека: Летопись/ }).click();
    await page.waitForURL(/#\/library$/);
    await page.getByLabel('Поиск по всем залам').fill('этикет');
    await page.locator('.volume', { hasText: 'Печать этикеток у ворот приёмки' }).getByText('утверждено как наследие').waitFor();
    await page.locator('.volume', { hasText: 'Цветная разметка зон' }).waitFor({ state: 'detached' });
    await shot(page, '06-search');
  });
  await as(
    storekeeper,
    async (page) => {
      await page.goto(`${BASE}/#/library`);
      await page.locator('.volume').first().waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) throw new Error('horizontal scroll on the phone');
      await shot(page, '07-phone');
    },
    { width: 390, height: 844 },
  );
  step('поиск по всем залам с уровнем проверки, здание на карте ведёт в библиотеку, телефон 390 px без прокрутки вбок');

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`ГОТОВО: цепочка «Наследия» пройдена за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} finally {
  await browser.close();
}
