/**
 * MODUS ADVISOR through the real UI (ADR-0013): a lead pastes a meeting
 * protocol → the rule-based template marks the task lines with exact quotes →
 * the lead confirms the facts of one (kind, wording, who raised it) and
 * dismisses another → an ordinary item appears, routed by the usual rules →
 * at the Council the item's lead sees executor suggestions with reasons and
 * confirms one → the decision owner's form preselects that person.
 * The page must say «без ИИ» while no model is connected.
 * Needs a freshly seeded demo database and the demo server:
 *   npm run demo:advisor   (BASE and PERSONAS override the defaults)
 */
import { chromium } from 'playwright';
import { signIn } from './sign-in.mjs';
import { readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const whHead = by('Начальник склада');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const storekeeper = by('Кладовщик');

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const expectText = async (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 });

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

try {
  // An employee does not get the protocol tab.
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/meeting/protocol`);
    await expectText(page, 'Протоколы совещаний разбирают руководители');
  });
  step('сотруднику протоколы недоступны');

  const n = await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/meeting`);
    await page.getByRole('link', { name: 'Протокол целиком' }).click();
    await page.getByRole('button', { name: 'Подставить пример (вымышленный)' }).click();
    await expectText(page, 'Модель не подключена');
    if (!(await page.getByRole('radio', { name: /Локальная модель/ }).isDisabled())) throw new Error('model option must be disabled without a model');
    await page.getByRole('button', { name: 'Найти задачи в протоколе' }).click();
    await page.waitForURL(/#\/meeting\/protocol\/[0-9a-f-]{36}/);
    await expectText(page, 'Разбор по шаблону (без ИИ)');
    const marks = await page.locator('.protocol-text mark.quote').count();
    if (marks !== 4) throw new Error(`expected 4 marked quotes, got ${marks}`);
    step('протокол разобран по шаблону: 4 цитаты отмечены в тексте, метка «без ИИ»');

    // Пункт 2: the scanner problem, raised by the service engineer.
    const card = page.locator('article.candidate').nth(1);
    await card.locator('blockquote', { hasText: 'сканер у ворот №2 зависает на холоде' }).waitFor();
    const who = await card.getByLabel('Кто поднял').inputValue();
    if (!who) throw new Error('the raiser named in the protocol should be preselected');
    await card.getByLabel('Название').fill('Сканер у ворот №2 зависает на холоде');
    await card.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
    await card.getByLabel('Подразделение').selectOption({ label: 'Склад и логистика' });
    await card.getByRole('button', { name: 'Подтвердить и зарегистрировать' }).click();
    const link = card.getByRole('link', { name: /обращение №\d+/ });
    await link.waitFor();
    const number = Number(/№(\d+)/.exec((await link.textContent()) ?? '')[1]);
    step(`пункт 2 подтверждён человеком → обращение №${number}`);

    await page.locator('article.candidate').nth(0).getByRole('button', { name: 'Не задача' }).click();
    await page.locator('article.candidate').nth(0).getByText(/Не задача — решил/).waitFor();
    step('пункт 1 отклонён и остался в истории');
    return number;
  });

  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/items/${n}`);
    await expectText(page, 'Протокол «Планёрка склада, 12 ноября», пункт 2');
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('heading', { name: 'Помощник Совета' }).waitFor();
    await expectText(page, 'Правила, без ИИ');
    const panel = page.locator('#advisor');
    await panel.getByText('Навыки из анкеты совпадают с текстом обращения').first().waitFor();
    const names = await panel.locator('.advisor-list > li b').allTextContents();
    if (!names.some((x) => x.includes('Руслан Исаев'))) throw new Error(`suggestions: ${names.join(' | ')}`);
    const row = panel.locator('.advisor-list > li', { hasText: 'Руслан Исаев' });
    await row.getByRole('button', { name: 'Подтвердить' }).click();
    await row.getByText('подтверждён').waitFor();
    step('ведущий видит подбор с причинами и подтверждает исполнителя');
  });

  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('button', { name: 'Принять решение' }).first().click();
    await expectText(page, 'Подтверждён на Совете: Руслан Исаев');
    const sel = await page.getByLabel('Кто внедряет').locator('option:checked').textContent();
    if (!sel?.includes('Руслан Исаев')) throw new Error(`preselected implementer: ${sel}`);
    step('в форме решения исполнитель предвыбран — решает ответственный');
  });

  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/me`);
    await expectText(page, 'Анкета: в чём я могу помочь');
    await page.waitForFunction(() => document.getElementById('q-skills')?.value.includes('Приёмка'), null, { timeout: 6000 });
    await page.getByLabel('Часов в неделю на улучшения').fill('3');
    await page.getByRole('button', { name: 'Сохранить анкету' }).click();
    await expectText(page, 'Анкета сохранена');
    step('сотрудник заполняет свою анкету');
  });

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`Сценарий ИИ-советника (без модели) пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} finally {
  await browser.close();
}
