/**
 * End-to-end check of the demo scenario through the real UI (Playwright).
 * Needs: a freshly seeded demo database, the API with MODUS_DEMO_LOGIN=true and
 * MODUS_SERVE_WEB=true, and a built web app. Usage:
 *   npm run demo:e2e   (from the repository root; BASE and PERSONAS override the defaults)
 * Each step asserts what the user sees; it exits non-zero on the first failure.
 */
import { chromium } from 'playwright';
import { signIn } from './sign-in.mjs';
import { readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const whHead = by('Начальник склада');
const engineer = by('Сервисный инженер');

const browser = schematic(await chromium.launch());
const errors = [];
const stamp = Date.now().toString(36);

async function as(person, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await signIn(page, person);
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const expectText = async (page, text) => {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout: 5000 });
};
const step = (name) => console.log(`✓ ${name}`);
/** Implemented items of a castle as the «Королевство» list states them. */
const towersOf = async (page, castle) => {
  await page.goto(`${BASE}/#/kingdom`);
  const row = page.locator('.realm-list button', { hasText: castle });
  await row.waitFor();
  const m = /Внедрено: (\d+)/.exec((await row.textContent()) ?? '');
  if (!m) throw new Error(`no tower count for ${castle}`);
  return Number(m[1]);
};
/** HTML5 drag and drop with real DOM events (mouse emulation can land on a neighbour card). */
const drag = async (page, source, target) => {
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
  await source.dispatchEvent('dragend', { dataTransfer: dt });
};
/** Selects the option whose text contains `text` (option labels carry job titles too). */
const pick = async (select, text) => {
  const label = (await select.locator('option', { hasText: text }).first().textContent())?.trim();
  await select.selectOption({ label });
};

try {
  // 1. Employee submits a problem; the system routes it and shows the deadline.
  let towersBefore = 0;
  const number = await as(storekeeper, async (page) => {
    towersBefore = await towersOf(page, 'Склад и логистика');
    await page.goto(`${BASE}/#/new`);
    await page.getByLabel(/Что происходит/).fill('Принтер этикеток на приёмке печатает пустые листы через раз, этикетки клеим от руки');
    await page.getByLabel('Коротко, одной строкой').fill(`Принтер этикеток печатает пустые листы ${stamp}`);
    await page.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
    await page.waitForURL(/#\/items\/\d+/);
    await expectText(page, 'На рассмотрении');
    await expectText(page, 'Первый ответ через');
    return Number(page.url().split('/').pop());
  });
  step(`подача: обращение №${number} назначено и получило срок`);

  // 2. The IT lead asks the author a question.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/work`);
    await page.getByRole('link', { name: new RegExp(stamp) }).click();
    await page.getByRole('button', { name: 'Задать вопрос автору' }).click();
    await page.getByLabel('Вопрос автору').fill('Какая модель принтера и с какого дня началось?');
    await page.getByRole('button', { name: 'Задать вопрос', exact: true }).click();
    await expectText(page, 'Нужны уточнения');
  });
  step('руководитель задал вопрос автору');

  // 3. The author sees the question and answers with a new version.
  await as(storekeeper, async (page) => {
    await expectText(page, 'Нужен ваш ответ');
    await page.goto(`${BASE}/#/items/${number}`);
    await page.getByRole('button', { name: 'Уточнить текст' }).click();
    await page.getByLabel('Что происходит').fill('Zebra у ворот №1 с понедельника печатает пустые листы через раз, этикетки клеим от руки');
    await page.getByLabel('Что уточнили').fill('Указала модель и с какого дня');
    await page.getByRole('button', { name: 'Сохранить новую версию' }).click();
    await expectText(page, 'Версия 2 из 2');
  });
  step('автор уточнил текст новой версией');

  // 4. The lead closes the question; the decision owner decides; the lead implements.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/items/${number}`);
    await page.getByRole('button', { name: 'Закрыть вопрос' }).click();
    await page.getByLabel('Чем закрыт вопрос').fill('Понятно, заменим термоголовку');
    await page.locator('form.composer').getByRole('button', { name: 'Закрыть вопрос' }).click();
    await expectText(page, 'Вопрос закрыт');
  });
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/items/${number}`);
    await page.getByRole('button', { name: 'Принять решение' }).click();
    await page.getByLabel('Почему внедряем').fill('Термоголовка дешевле, чем ручная маркировка');
    await pick(page.getByLabel('Кто внедряет'), itLead.name);
    await page.locator('form.composer button[type=submit]').click();
    await expectText(page, 'В реализации');
  });
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/items/${number}`);
    await page.getByRole('button', { name: 'Сообщить о ходе работ' }).click();
    await page.getByLabel('Что сделано и что дальше').fill('Термоголовка заказана, придёт в четверг');
    await page.getByRole('button', { name: 'Отправить отчёт' }).click();
    await expectText(page, 'Отчёт отправлен');
    await page.getByRole('button', { name: 'Отметить как реализовано' }).click();
    await page.getByLabel('Что внедрено').fill('Термоголовка заменена, пустых листов нет');
    // Wait for the server's answer: «реализовано» is already on the page in the button's own label,
    // so a text match alone could close the page while the request is still in flight.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/ideas/${number}/implementation`) && r.status() === 201),
      page.locator('form.composer').getByRole('button', { name: 'Отметить как реализовано' }).click(),
    ]);
    await expectText(page, 'Реализовано');
  });
  step('решение принято, исполнитель отчитался, обращение реализовано');

  // 5. The author sees the result and the full history.
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/items/${number}`);
    await expectText(page, 'Реализовано');
    await expectText(page, 'Термоголовка заменена');
    await expectText(page, 'задаёт вопрос автору');
  });
  step('автор видит результат и всю историю');

  // 5a. The department's castle gains a tower only for the implemented item.
  await as(storekeeper, async (page) => {
    const after = await towersOf(page, 'Склад и логистика');
    if (after !== towersBefore + 1) throw new Error(`towers ${towersBefore} → ${after}, expected +1`);
    await page.locator('.realm-map svg').waitFor();
    await expectText(page, 'Мои обращения на карте');
  });
  step('королевство: подтверждённое внедрение засчитано замку склада');

  // 6. A head records a question heard on the phone on behalf of an engineer.
  const n2 = await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/new`);
    await page.getByLabel(/Что происходит/).fill('Инженеры не знают, где на складе забирать комплекты для объектов, ищут по полчаса');
    await page.getByLabel('Коротко, одной строкой').fill(`Где забирать комплекты для объектов ${stamp}`);
    await page.getByText('Записываю со слов коллеги').click();
    await pick(page.getByLabel('Чей это вопрос'), engineer.name);
    await page.getByLabel('Откуда вопрос').selectOption({ label: 'Звонок' });
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
    await page.waitForURL(/#\/items\/\d+/);
    await expectText(page, `${engineer.name} — записал`);
    return Number(page.url().split('/').pop());
  });
  await as(engineer, async (page) => {
    await expectText(page, `Где забирать комплекты для объектов ${stamp}`);
    await page.goto(`${BASE}/#/inbox`);
    await expectText(page, `№${n2}`);
  });
  step(`вопрос со звонка записан за инженером (№${n2}), он его видит и получил уведомление`);

  // 7. Meeting review: two questions from one planning meeting, each with its own raiser.
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/meeting`);
    await page.getByLabel('Какая встреча').fill(`Планёрка склада ${stamp}`);
    await page.getByLabel('Вопрос 1').fill('Погрузчик №2 третью неделю стоит без зарядного устройства, работаем одним');
    await pick(page.getByLabel('Кто поднял').first(), storekeeper.name);
    await page.getByLabel('Вопрос 2').fill('Предлагаю вешать график отгрузок на неделю у ворот, водители постоянно спрашивают');
    await pick(page.getByLabel('Кто поднял').nth(1), engineer.name);
    await page.getByRole('button', { name: 'Зарегистрировать 2 обращения' }).click();
    await expectText(page, 'Готово: 2');
  });
  await as(storekeeper, async (page) => {
    await expectText(page, 'Погрузчик №2 третью неделю стоит без зарядного устройства');
  });
  step('разбор совещания: два вопроса зарегистрированы, каждый за своим автором');

  // 8. Shared from WhatsApp (Android share target): the form opens with the text.
  await as(whHead, async (page) => {
    const text = `Ребята, в зоне отгрузки опять нет стрейч-плёнки, ждём со вчера ${stamp}`;
    await page.goto(`${BASE}/share?text=${encodeURIComponent(text)}`);
    await expectText(page, 'Текст из сообщения вставлен');
    if ((await page.getByLabel(/Что происходит/).inputValue()) !== text) throw new Error('shared text was not prefilled');
    await page.getByLabel('Коротко, одной строкой').fill(`Нет стрейч-плёнки в отгрузке ${stamp}`);
    await pick(page.getByLabel('Чей это вопрос'), storekeeper.name);
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
    await page.waitForURL(/#\/items\/\d+/);
    await expectText(page, 'Мессенджер');
  });
  step('сообщение из WhatsApp через «Поделиться» стало обращением с источником «Мессенджер»');

  // 9. Kanban: dragging a card opens the workflow step; disallowed moves are explained.
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/board`);
    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await page.waitForLoadState('networkidle');
    // A seeded unrouted item that Oleg did not raise (fresh demo database).
    const href = await page.locator('section[aria-label^="Новые"] .card').filter({ hasText: 'Нет общей базы знаний' }).first().locator('a.card-title').getAttribute('href');
    const card = page.locator('.card', { has: page.locator(`a[href="${href}"]`) });
    await drag(page, card, page.locator('section[aria-label^="Рассмотрение"]'));
    await page.locator('dialog').getByRole('button', { name: 'Взять в работу' }).click();
    await expectText(page, 'вы ведёте обращение');
    await page.locator(`section[aria-label^="Рассмотрение"] a[href="${href}"]`).waitFor({ timeout: 5000 });

    const reviewCard = page.locator('section[aria-label^="Рассмотрение"] .card').first();
    await drag(page, reviewCard, page.locator('section[aria-label^="Решение"]'));
    await expectText(page, 'переходит само после проверки');
    await page.locator('dialog').getByRole('button', { name: 'Понятно' }).click();
  });
  step('канбан: перетаскивание открывает нужный шаг, запрещённый переход объяснён');

  // 10. Forms keep work and explain errors (UI UX Pro Max: form-autosave, error-placement, focus-management).
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/new`);
    await page.getByLabel(/Что происходит/).fill(`Черновик: в раздевалке не работает вентиляция ${stamp}`);
    await page.reload();
    await page.waitForSelector('.shell');
    await expectText(page, 'Восстановлен черновик');
    await page.getByRole('button', { name: 'Начать заново' }).click();
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'problem') throw new Error(`focus went to ${focused}, expected the first invalid field`);
    await expectText(page, 'Опишите, что происходит');
  });
  step('черновик переживает перезагрузку; пустая отправка ведёт к первому полю с ошибкой');

  // 11. Owner overview loads with facts.
  await as(by('Собственник компании'), async (page) => {
    await page.goto(`${BASE}/#/overview`);
    await expectText(page, 'Откуда приходят вопросы');
    await expectText(page, 'Звонок');
  });
  step('обзор собственника открывается');

  if (errors.length) throw new Error(`ошибки в браузере: ${errors.join('; ')}`);
  console.log('Сценарий пройден');
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
