/**
 * Council meeting with recording through the real UI (ADR-0014):
 *   titles in the profile → a lead calls a meeting → the participant consents →
 *   microphone recording with a visible indicator, pause, stop, save → on the
 *   warehouse meeting called in advance: upload of the PREPARED demo audio →
 *   PREPARED transcript (labelled) → findings by template (labelled «без ИИ») →
 *   ▶ plays the exact moment → a lead confirms one finding → an ordinary item,
 *   routed by the usual rules → notifications → kanban → origin on the card →
 *   a non-participant sees nothing.
 * Chromium's fake microphone is used for the recording step. Needs a freshly
 * seeded demo database and the demo server:   npm run demo:meeting
 */
import { chromium } from 'playwright';
import { signIn } from './sign-in.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const whHead = by('Начальник склада');
const storekeeper = by('Кладовщик');
const itLead = by('Руководитель ИТ-разработки');
const owner = by('Собственник компании');
const AUDIO = resolve('docs/demo/planerka-demo.ogg');

const browser = schematic(await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }));
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const expectText = async (page, text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });

async function as(person, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.setItem('modus.howto.hidden', '1'); } catch {} });
  await signIn(page, person);
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const meetingId = (page) => /#\/meetings\/([0-9a-f-]{36})/.exec(page.url())?.[1];

try {
  // 1. A person, their castle and their game title — next to the real job, without rights.
  await as(storekeeper, async (page) => {
    await page.locator('.who .title-chip', { hasText: 'Шебер' }).waitFor();
    await page.goto(`${BASE}/#/me`);
    await expectText(page, 'Звание прав не даёт');
    await page.locator('.identity .title-chip', { hasText: 'Шебер' }).waitFor();
    const identity = await page.locator('.identity').textContent();
    if (!identity?.includes('Кладовщик') || !identity.includes('Шебер')) throw new Error(`identity: ${identity}`);
    step('Асель: должность «Кладовщик» и звание «Шебер» рядом; звание прав не даёт');
  });

  // 2. A lead calls a meeting; the participant consents; recording with indicator, pause, stop, save.
  const fresh = await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.realm-list button', { hasText: 'Склад и логистика' }).click();
    await page.getByRole('link', { name: 'Созвать малый совет с записью' }).click();
    await page.getByLabel('Тема').fill('Короткая проверка записи');
    // The small council starts with the whole department; keep only the storekeeper (the list shrinks as boxes are unchecked).
    while (await page.locator('.pick-list input:checked').count()) await page.locator('.pick-list input:checked').first().uncheck();
    await page.locator('.pick-list label', { hasText: storekeeper.name }).locator('input').check();
    await page.getByLabel(/Я согласен\(на\) на запись/).check();
    await page.getByRole('button', { name: 'Созвать заседание' }).click();
    await page.waitForURL(/#\/meetings\/[0-9a-f-]{36}$/);
    await expectText(page, 'Запись станет доступна, когда согласие дадут все');
    step('Олег созвал малый совет; запись заблокирована до согласия всех');
    return meetingId(page);
  });
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await page.locator('li.scroll', { hasText: 'Созван малый совет: Ханская юрта' }).first().getByRole('button', { name: 'Войти в Совет' }).click();
    await page.waitForURL(new RegExp(fresh));
    await page.getByRole('button', { name: 'Согласен(на) на запись' }).click();
    await expectText(page, 'Вы дали согласие');
    step('Асель получила уведомление «Созван малый совет: Ханская юрта» и сама дала согласие');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/meetings/${fresh}`);
    await page.getByRole('button', { name: 'Начать запись' }).click();
    await page.locator('.rec-indicator', { hasText: 'Идёт запись' }).waitFor();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Пауза' }).click();
    await page.locator('.rec-indicator', { hasText: 'Запись на паузе' }).waitFor();
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Завершить запись' }).click();
    await page.getByRole('button', { name: 'Сохранить запись' }).click();
    await page.locator('audio.audio').waitFor();
    await expectText(page, 'Записано в приложении');
    step('запись с микрофона: индикатор, пауза, продолжение, стоп, сохранение');
  });

  // 3. The warehouse meeting called in advance: prepared audio + prepared transcript → findings.
  const n = await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/meetings`);
    await page.getByRole('link', { name: /Планёрка склада: приёмка и этикетки/ }).click();
    await page.waitForURL(/#\/meetings\/[0-9a-f-]{36}$/);
    await page.getByLabel('Файл записи заседания').setInputFiles(AUDIO);
    await expectText(page, 'Загружен файл');
    await page.getByRole('button', { name: 'Подставить подготовленную (демо)' }).click();
    await page.getByRole('button', { name: 'Сохранить расшифровку' }).click();
    await expectText(page, 'Подготовленная расшифровка для демонстрации — не распознана из этой записи');
    step('загружена подготовленная запись, расшифровка помечена как подготовленная');

    await page.getByRole('button', { name: 'Найти по шаблону (без ИИ)' }).click();
    await page.locator('article.finding').first().waitFor();
    const types = await page.locator('article.finding .finding-type').allTextContents();
    const want = ['Проблема', 'Проблема', 'Идея', 'Возражение', 'Наблюдение', 'Открытый вопрос', 'Решение'];
    if (types.join('|') !== want.join('|')) throw new Error(`finding types: ${types.join(' | ')}`);
    if (await page.getByRole('button', { name: /Локальной моделью/ }).count()) throw new Error('model button must not claim a model');
    step('найдено по шаблону: 2 проблемы, идея, возражение, наблюдение, открытый вопрос, решение');

    const idea = page.locator('article.finding', { has: page.locator('.finding-type', { hasText: 'Идея' }) });
    await idea.getByRole('button', { name: /Прослушать фрагмент с 00:15/ }).click();
    await page.waitForFunction(() => {
      const a = document.querySelector('audio.audio');
      return a && a.currentTime >= 15 && a.currentTime < 20;
    }, null, { timeout: 6000 });
    step('▶ 00:15 включает запись ровно с реплики Асель');

    await idea.getByRole('button', { name: 'Проверить и создать обращение' }).click();
    await idea.getByLabel('Название').fill('Печать этикеток со сканера у ворот');
    await idea.getByLabel('Что сейчас не так').fill('Этикетки печатают на отдельном компьютере, 3–4 минуты на машину');
    await idea.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
    const who = await idea.getByLabel('Кто поднял').locator('option:checked').textContent();
    if (!who?.includes(storekeeper.name)) throw new Error(`raised by preselected: ${who}`);
    await idea.getByRole('button', { name: 'Подтвердить и зарегистрировать' }).click();
    const link = idea.getByRole('link', { name: /обращение №\d+/ });
    await link.waitFor();
    const number = Number(/№(\d+)/.exec((await link.textContent()) ?? '')[1]);
    const insight = page.locator('article.finding', { has: page.locator('.finding-type', { hasText: 'Наблюдение' }) });
    await insight.getByRole('button', { name: 'В память без обращения' }).click();
    await insight.getByText(/Сохранено в памяти компании/).waitFor();
    step(`руководитель подтвердил идею → обращение №${number}; наблюдение — в память`);
    return number;
  });

  // 4. Workflow: routing, notifications, kanban, origin on the card.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await page.locator('li.scroll', { hasText: 'В замок прибыл посол' }).filter({ hasText: 'Печать этикеток со сканера у ворот' }).first().waitFor();
    await page.goto(`${BASE}/#/board`);
    await page.locator('.card', { hasText: 'Печать этикеток со сканера у ворот' }).first().waitFor();
    await page.goto(`${BASE}/#/items/${n}`);
    await expectText(page, 'Возникло на заседании');
    await expectText(page, 'По подготовленной расшифровке (демо)');
    step('Дмитрий (ведёт ИТ): «В замок прибыл посол», карточка на канбане, на карточке — откуда взялось');
  });
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/inbox`);
    await page.locator('li.scroll', { hasText: 'Ваш вопрос записан' }).first().waitFor();
    step('Асель: «Ваш вопрос записан» — заслуга за ней');
  });

  // 5. Someone who was not at the meeting sees nothing of it.
  await as(owner, async (page) => {
    await page.goto(`${BASE}/#/meetings/${fresh}`);
    await expectText(page, 'не найдено или вы не участник');
    await page.goto(`${BASE}/#/items/${n}`);
    await page.locator('.passport, .item-head, h1').first().waitFor();
    if (await page.getByText('Возникло на заседании').count()) throw new Error('origin leaked to a non-participant');
    step('собственник не был на заседании: ни записи, ни расшифровки, ни цитаты');
  });

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`Сценарий заседания с записью пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} finally {
  await browser.close();
}
