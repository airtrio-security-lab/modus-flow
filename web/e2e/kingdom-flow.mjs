/**
 * The 90-second kingdom scenario through the real UI (owner brief 2026-11-11):
 * an idea from the warehouse → envoy on the map → round-table Council →
 * the decision owner decides → implementation → result confirmed → castle XP
 * and level → rating. Every number is read back from the screen; nothing is
 * faked. Needs a freshly seeded demo database (scripts/demo-local.sh) and:
 *   npm run demo:kingdom   (BASE and PERSONAS override the defaults)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const whHead = by('Начальник склада');
const engineer = by('Сервисный инженер');
const owner = by('Собственник компании');
const THRESHOLDS = [0, 100, 250, 500, 900];
const NAMES = ['Поселение', 'Крепость', 'Цитадель', 'Королевский замок', 'Легендарная крепость'];
const levelOf = (xp) => THRESHOLDS.filter((t) => xp >= t).length;

const browser = await chromium.launch();
const errors = [];
// Fresh demo data needs no suffix; STAMP=1 adds one to rerun on the same database.
const stamp = process.env.STAMP ? ` ${Date.now().toString(36)}` : '';
const t0 = Date.now();

async function as(person, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
const expectText = async (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 6000 });
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const pick = async (select, text) => {
  const label = (await select.locator('option', { hasText: text }).first().textContent())?.trim();
  await select.selectOption({ label });
};
/** XP and level of the warehouse castle as the kingdom list shows them. */
const castle = async (page) => {
  await page.goto(`${BASE}/#/kingdom`);
  const row = page.locator('.realm-list button', { hasText: 'Склад и логистика' });
  await row.waitFor();
  const m = /Уровень (\d) · ([^·]+) · (\d+) XP/.exec((await row.textContent()) ?? '');
  if (!m) throw new Error('no level line for the warehouse castle');
  return { level: Number(m[1]), name: m[2].trim(), xp: Number(m[3]) };
};

try {
  // 1–2. A storekeeper proposes an optimisation; her envoy leaves the castle.
  let before;
  const n = await as(storekeeper, async (page) => {
    before = await castle(page);
    await page.goto(`${BASE}/#/new`);
    await page.getByRole('button', { name: 'Предложить улучшение' }).click();
    await page.getByLabel(/Что сейчас не так/).fill('На приёмке этикетку печатаем на отдельном компьютере и несём к паллете, теряем по 3–4 минуты на машину');
    await page.getByLabel(/Что предлагаете/).fill('Печатать этикетку прямо со сканера на мобильный принтер у ворот, без похода к компьютеру');
    await page.getByLabel('Коротко, одной строкой').fill(`Печать этикеток со сканера у ворот${stamp}`);
    await page.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
    await page.getByRole('button', { name: 'Отправить обращение' }).click();
    await page.waitForURL(/#\/items\/\d+/);
    const num = Number(page.url().split('/').pop());
    await page.goto(`${BASE}/#/kingdom`);
    await expectText(page, `Обращение №${num}`);
    return num;
  });
  step(`склад предложил идею №${n}; посол вышел из замка (${before.xp} XP, ${before.name})`);

  // 3–4. The envoy reaches the Council; members argue, the lead recommends and hands it over.
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByLabel('Ваш довод').fill('Сэкономим около часа в день на приёмке');
    await page.getByRole('button', { name: 'Добавить аргумент' }).click();
    await expectText(page, 'Аргумент добавлен');
  });
  await as(engineer, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('radio', { name: 'Аргумент против' }).click();
    await page.getByLabel('Ваш довод').fill('Нужен запасной принтер, иначе встанет приёмка');
    await page.getByRole('button', { name: 'Добавить аргумент' }).click();
    await expectText(page, 'Аргумент добавлен');
  });
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await page.getByRole('radio', { name: 'Рекомендация' }).click();
    await page.getByLabel('Рекомендация', { exact: true }).selectOption('implement');
    await page.getByLabel('Обоснование').fill('Принтеры есть на складе, нужна только настройка сканеров');
    await page.getByRole('button', { name: 'Записать рекомендацию' }).click();
    await expectText(page, 'Рекомендация записана');
    await page.getByRole('button', { name: 'Передать на решение' }).click();
    await page.locator('form.council-form').getByRole('button', { name: 'Передать на решение' }).click();
    await expectText(page, 'Передано на решение');
  });
  step('Совет: аргументы за и против, рекомендация, передано решающему');

  // 5. The authorised decision owner decides — the Council only advised.
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/council/${n}`);
    await expectText(page, 'Рекомендации Совета — это совет, а не решение');
    await page.getByRole('button', { name: 'Принять решение' }).first().click();
    await page.getByLabel('Почему внедряем').fill('Совет за, риск закрываем запасным принтером');
    await pick(page.getByLabel('Кто внедряет'), itLead.name);
    await page.locator('form.council-form button[type=submit]').click();
    await expectText(page, 'Решение: внедрять');
  });
  step('операционный директор принял решение: внедрять');

  // 6–7. Implementation and confirmation of the result.
  await as(itLead, async (page) => {
    await page.goto(`${BASE}/#/items/${n}`);
    await page.getByRole('button', { name: 'Сообщить о ходе работ' }).click();
    await page.getByLabel('Что сделано и что дальше').fill('Сканеры настроены, два принтера у ворот №1 и №2');
    await page.getByRole('button', { name: 'Отправить отчёт' }).click();
    await expectText(page, 'Отчёт отправлен');
    await page.getByRole('button', { name: 'Отметить как реализовано' }).click();
    await page.getByLabel('Что внедрено').fill('Этикетки печатаются у ворот, к компьютеру больше не ходим');
    await page.locator('form.composer').getByRole('button', { name: 'Отметить как реализовано' }).click();
    await expectText(page, 'Внедрение подтверждено');
  });
  step('внедрено и подтверждено исполнителем');

  // 8–9. The castle receives XP; at a threshold it reaches the next level.
  const afterImpl = await as(storekeeper, (page) => castle(page));
  if (afterImpl.xp !== before.xp + 100) throw new Error(`XP ${before.xp} → ${afterImpl.xp}, expected +100`);
  if (afterImpl.level !== levelOf(afterImpl.xp)) throw new Error(`level ${afterImpl.level} for ${afterImpl.xp} XP`);
  const levelled = afterImpl.level > before.level;
  step(`замок склада: ${before.xp} → ${afterImpl.xp} XP${levelled ? `, новый уровень «${afterImpl.name}»` : ''}`);
  if (levelled && afterImpl.name !== NAMES[afterImpl.level - 1]) throw new Error('level name mismatch');

  // The decision owner confirms the documented effect: up to +50 XP, once.
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/items/${n}`);
    await page.getByRole('button', { name: 'Подтвердить эффект' }).click();
    await page.getByLabel(/Бонус, XP/).fill('50');
    await page.getByLabel('Что подтверждено и каким документом').fill('Неделя замеров: приёмка машины быстрее на 4 минуты, хронометраж приложен');
    await page.getByRole('button', { name: /Подтвердить эффект: \+50 XP/ }).click();
    await expectText(page, 'Эффект подтверждён');
  });
  const afterEffect = await as(storekeeper, async (page) => {
    const c = await castle(page);
    await expectText(page, 'Мои обращения на карте');
    return c;
  });
  if (afterEffect.xp !== afterImpl.xp + 50) throw new Error(`effect: ${afterImpl.xp} → ${afterEffect.xp}`);
  step(`эффект подтверждён: ${afterEffect.xp} XP`);

  // 10. The rating is updated from the same events.
  await as(owner, async (page) => {
    await page.goto(`${BASE}/#/rating`);
    const row = page.locator('table.rating tbody tr', { hasText: 'Склад и логистика' });
    await row.waitFor();
    const text = (await row.textContent()) ?? '';
    if (!text.includes(String(afterEffect.xp))) throw new Error(`rating row: ${text}`);
  });
  step('рейтинг подразделений обновился');

  if (errors.length) throw new Error(`ошибки в браузере: ${errors.join('; ')}`);
  console.log(`Сценарий «Королевство» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
