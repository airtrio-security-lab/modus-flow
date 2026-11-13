/**
 * The final demonstration as ONE story through the real UI (owner brief 2026-11-11, stabilization):
 *   initiative → envoy on the map → royal council → decision → implementation → castle XP →
 *   castle growth → Летопись → Библиотека решений → Высший Архив.
 * One browser tab, the persona changes through the demo sign-in, a caption names each step.
 * Every number and level is read back from the screen and checked; nothing is staged.
 *
 *   npm run demo:final                 — the rehearsal, fast, with checks (~30 s)
 *   RECORD=1 npm run demo:final        — the same at presentation pace (PACE=3), recorded as the fallback video
 *                                         .demo/final-demo.webm (+ .mp4 with ffmpeg)
 * Needs a freshly seeded demo database and the demo server (scripts/demo-local.sh --fresh).
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const OUT = process.env.OUT ?? '.demo';
const RECORD = !!process.env.RECORD;
const SHOTS = process.env.SHOTS ?? null;
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const whHead = by('Начальник склада');
const engineer = by('Сервисный инженер');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const owner = by('Собственник компании');
const archivist = by('Архивариус');
const NAMES = ['Поселение', 'Крепость', 'Цитадель', 'Королевский замок', 'Легендарная крепость'];

if (RECORD) mkdirSync(join(OUT, 'video-tmp'), { recursive: true });
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const browser = schematic(await chromium.launch());
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  ...(RECORD ? { recordVideo: { dir: join(OUT, 'video-tmp'), size: { width: 1280, height: 800 } } } : {}),
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
// Presentation pace for the recording: long enough to read every caption while the speaker talks.
const PACE = Number(process.env.PACE ?? 3);
const pause = (ms) => (RECORD ? new Promise((r) => setTimeout(r, ms * PACE)) : Promise.resolve());
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const expectText = async (text, timeout = 8000) => page.getByText(text, { exact: false }).first().waitFor({ timeout });
const shot = async (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : undefined);

async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-caption';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;max-width:80%;padding:10px 18px;border-radius:10px;background:rgba(27,34,37,.92);color:#fff;font:600 17px "IBM Plex Sans",Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}
/**
 * Cinematic notifications (ADR-0037): after a colleague's action on this same device the next person
 * may be greeted by a scene. The story goes on: when recording the scene plays to its end, otherwise
 * it is skipped at once. Every scene met is listed at the end of the run.
 */
const scenesMet = [];
async function passScene(who) {
  await page.waitForFunction(() => document.documentElement.dataset.cineChecked === '1', null, { timeout: 15000 });
  for (let i = 0; i < 4; i++) {
    const box = page.locator('dialog.cine[open], .cine-text');
    if (!(await box.count())) return;
    scenesMet.push(`${who}: ${(await box.locator('h2').first().textContent())?.trim()}`);
    if (RECORD) await page.waitForFunction(() => { const v = document.querySelector('dialog.cine[open] video'); return !v || v.ended; }, null, { timeout: 8000 }).catch(() => undefined);
    const close = box.getByRole('button', { name: /^(Пропустить|Позже|Закрыть)$/ }).first();
    await close.click();
    await box.first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  }
}
async function signIn(person, text) {
  if (page.url().startsWith('http')) await page.evaluate(() => sessionStorage.clear());
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.setItem('modus.lite', '0'); localStorage.setItem('modus.howto.hidden', '1'); } catch {} });
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  await passScene(person.name);
  if (text) await caption(text);
  await pause(800);
}
const go = async (hash, text) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForTimeout(150);
  if (text) await caption(text);
  await pause(700);
};
const typeIn = async (locator, text) => (RECORD ? (await locator.click(), locator.pressSequentially(text, { delay: 6 })) : locator.fill(text));
const castle = async () => {
  await go('#/kingdom');
  const row = page.locator('.realm-list button', { hasText: 'Склад и логистика' });
  await row.waitFor();
  const m = /Уровень (\d) · ([^·]+) · (\d+) XP/.exec((await row.textContent()) ?? '');
  if (!m) throw new Error('no level line for the warehouse castle');
  return { level: Number(m[1]), name: m[2].trim(), xp: Number(m[3]) };
};
async function act(label, reason) {
  await page.getByRole('button', { name: label, exact: true }).click();
  if (reason) await typeIn(page.locator('#act-reason'), reason);
  await page.locator('.k-confirm').getByRole('button', { name: label, exact: true }).click();
  await page.locator('.k-confirm').waitFor({ state: 'detached' });
}

try {
  // ---- 1. Initiative ----
  await signIn(storekeeper, '1. Кладовщик Асель предлагает улучшение');
  const before = await castle();
  await go('#/new', '1. Идея своими словами: что не так и что предлагаю');
  await page.getByRole('button', { name: 'Предложить улучшение' }).click();
  await typeIn(page.getByLabel(/Что сейчас не так/), 'Этикетку печатаем на отдельном компьютере и несём к паллете — 3–4 минуты на машину');
  await typeIn(page.getByLabel(/Что предлагаете/), 'Печатать этикетку со сканера на мобильный принтер у ворот');
  await typeIn(page.getByLabel('Коротко, одной строкой'), 'Печать этикеток со сканера у ворот');
  await page.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await page.waitForURL(/#\/items\/\d+/);
  const n = Number(page.url().split('/').pop());
  await caption(`1. Обращение №${n}: ответственный и срок назначены сразу`);
  await pause(2000);
  step(`1. инициатива: обращение №${n}`);

  // ---- 2. The envoy ----
  await go('#/kingdom', `2. Посол «Обращение №${n}» вышел из замка склада к Совету`);
  await expectText(`Обращение №${n}`);
  await shot('02-envoy');
  await pause(2500);
  step('2. посол на карте');

  // ---- 3. Royal council ----
  await signIn(whHead, '3. Королевский совет: начальник склада — довод «за»');
  await go(`#/council/${n}`);
  await typeIn(page.getByLabel('Ваш довод'), 'Сэкономим около часа в день на приёмке');
  await page.getByRole('button', { name: 'Добавить аргумент' }).click();
  await expectText('Аргумент добавлен');
  await signIn(engineer, '3. Королевский совет: сервисный инженер — довод «против»');
  await go(`#/council/${n}`);
  await page.getByRole('radio', { name: 'Аргумент против' }).click();
  await typeIn(page.getByLabel('Ваш довод'), 'Нужен запасной принтер, иначе встанет приёмка');
  await page.getByRole('button', { name: 'Добавить аргумент' }).click();
  await expectText('Аргумент добавлен');
  await signIn(itLead, '3. Ведущий рекомендует внедрить и передаёт решение ответственному');
  await go(`#/council/${n}`);
  await page.getByRole('radio', { name: 'Рекомендация' }).click();
  await page.getByLabel('Рекомендация', { exact: true }).selectOption('implement');
  await typeIn(page.getByLabel('Обоснование'), 'Принтеры есть на складе, нужна только настройка сканеров');
  await page.getByRole('button', { name: 'Записать рекомендацию' }).click();
  await expectText('Рекомендация записана');
  await page.getByRole('button', { name: 'Передать на решение' }).click();
  await page.locator('form.council-form').getByRole('button', { name: 'Передать на решение' }).click();
  await expectText('Передано на решение');
  await shot('03-council');
  step('3. Совет: доводы за и против, рекомендация');

  // ---- 4. Decision by the authorized person ----
  await signIn(ops, '4. Решает ответственный — Совет только советует');
  await go(`#/council/${n}`);
  await expectText('Рекомендации Совета — это совет, а не решение');
  await page.getByRole('button', { name: 'Принять решение' }).first().click();
  await typeIn(page.getByLabel('Почему внедряем'), 'Совет за, риск закрываем запасным принтером');
  const impl = page.getByLabel('Кто внедряет');
  await impl.selectOption({ label: (await impl.locator('option', { hasText: itLead.name }).first().textContent()).trim() });
  await page.locator('form.council-form button[type=submit]').click();
  await expectText('Решение: внедрять');
  await pause(1500);
  step('4. решение: внедрять');

  // ---- 5. Implementation ----
  await signIn(itLead, '5. Внедрение: исполнитель отчитывается и подтверждает');
  await go(`#/items/${n}`);
  await page.getByRole('button', { name: 'Отметить как реализовано' }).click();
  await typeIn(page.getByLabel('Что внедрено'), 'Этикетки печатаются у ворот, к компьютеру больше не ходим');
  await page.locator('form.composer').getByRole('button', { name: 'Отметить как реализовано' }).click();
  await expectText('Внедрение подтверждено');
  await caption('5. Внедрение подтверждено — база сама начисляет замку опыт');
  await pause(2000);
  step('5. внедрено');

  // ---- 6–7. XP and the castle grows ----
  await signIn(ops, '6. Ответственный подтверждает эффект замером: бонус до +50 XP, один раз');
  await go(`#/items/${n}`);
  await page.getByRole('button', { name: 'Подтвердить эффект' }).click();
  await page.getByLabel(/Бонус, XP/).fill('50');
  await typeIn(page.getByLabel('Что подтверждено и каким документом'), 'Хронометраж недели: приёмка машины быстрее на 4 минуты');
  await page.getByRole('button', { name: /Подтвердить эффект: \+50 XP/ }).click();
  await expectText('Эффект подтверждён');
  await signIn(storekeeper);
  const after = await castle();
  if (after.xp !== before.xp + 150) throw new Error(`XP ${before.xp} → ${after.xp}, expected +150`);
  await page.locator('.realm-list button', { hasText: 'Склад и логистика' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await caption(`7. Замок склада: ${before.xp} → ${after.xp} XP${after.level > before.level ? `, новый уровень «${after.name}»` : ''}. Опыт — только за подтверждённое`);
  if (after.level > before.level && after.name !== NAMES[after.level - 1]) throw new Error('level name mismatch');
  await shot('07-castle');
  await pause(3500);
  step(`6–7. XP ${before.xp} → ${after.xp}, уровень ${before.level} → ${after.level} «${after.name}»`);

  // ---- 8. Летопись: from the item page, a draft from the item's own fields ----
  await signIn(itLead, '8. Летопись: итог вносится одной кнопкой со страницы обращения');
  await go(`#/items/${n}`);
  await page.getByRole('link', { name: 'Внести в Летопись' }).click();
  await expectText('Черновик собран из полей обращения');
  await page.getByLabel('Вид знания').selectOption('improvement');
  await pause(1500);
  await page.getByRole('button', { name: 'Внести в Летопись' }).click();
  await page.waitForURL(/#\/library\/[0-9a-f-]{36}$/);
  const kid = page.url().split('/').pop();
  await expectText('зарегистрировано, не проверено');
  await caption('8. Летопись: проблема, доводы Совета, решение и результат — из записей процесса');
  await shot('08-chronicle');
  await pause(2500);
  await act('Предложить в Библиотеку', 'Решение внедрено, эффект подтверждён замером');
  step('8. Летопись: запись зарегистрирована и предложена в Библиотеку');

  // ---- 9. Библиотека решений: the archivist checks ----
  await signIn(archivist, '9. Библиотека решений: Архивариус проверяет источники и доказательства');
  await go(`#/library/${kid}`);
  await act('Внести в Библиотеку', 'Проверила отчёт о внедрении и замер эффекта');
  await expectText('проверено Архивариусом');
  // The conclusion for the Higher Archive is a new version of the card.
  await page.getByRole('button', { name: 'Новая версия карточки' }).click();
  await page.getByLabel('Категория наследия').selectOption('improvement');
  await typeIn(page.getByLabel('Доказанность'), `Отчёт о внедрении по обращению №${n} и подтверждённый замер эффекта.`);
  await typeIn(page.getByLabel('Область применимости'), 'Склады с приёмкой у ворот и сканерами с Bluetooth.');
  await typeIn(page.getByLabel('Основания включения'), 'Подтверждённое улучшение: приёмка быстрее на 4 минуты на машину.');
  await page.getByLabel('Дата последней проверки').fill('2026-11-11');
  await typeIn(page.getByLabel('Причина изменения'), 'Заключение для Высшего Архива');
  await page.getByRole('button', { name: 'Сохранить версию' }).click();
  await expectText('Версия 2');
  await act('Представить заключение Совету', 'Улучшение подтверждено замером');
  await expectText('Заключение Архивариуса ждёт утверждения');
  await shot('09-library');
  step('9. Библиотека: проверено Архивариусом, заключение представлено');

  // ---- 10. Высший Архив: the King approves; the animation follows the confirmed approval ----
  await signIn(owner, '10. Высший Архив: послание Королю — утверждает уполномоченный человек');
  await go('#/inbox');
  await expectText('Ваше Величество, Архивариус представил новое знание для рассмотрения Советом');
  await pause(2000);
  await page.locator('li.scroll', { hasText: 'Архивариус представил новое знание' }).getByRole('button', { name: 'Открыть в Великой библиотеке' }).click();
  await page.waitForURL(new RegExp(`#/library/${kid}$`));
  await act('Утвердить включение в Высший Архив', 'Утверждаю: эффект доказан замером');
  await page.locator('.vault').waitFor();
  await caption('10. Том занял место в Высшем Архиве — после подтверждения, не раньше');
  await page.waitForTimeout(1900);
  await shot('10-vault');
  await pause(1500);
  // The overlay closes by itself after a few seconds; at presentation pace it may already be gone.
  if (await page.locator('.vault').isVisible()) await page.locator('.vault').click();
  await expectText('утверждено как наследие');
  await go('#/library', '10. Великая библиотека: что решили, почему, результат и чему научились');
  await page.getByLabel('Какое решение или опыт вы ищете?').fill('этикет');
  await page.locator('.volume', { hasText: 'Печать этикеток со сканера у ворот' }).getByText('утверждено как наследие').waitFor();
  await shot('10-search');
  await pause(3500);
  await caption('Все люди и данные вымышлены. Каждый шаг — запись в базе, проверенная правами.');
  await pause(2000);
  step('10. Высший Архив: утверждено Собственником, найдено общим поиском');

  if (errors.length) throw new Error(`ошибки в браузере: ${errors.join('; ')}`);
  console.log(`ГОТОВО: финальная история пройдена за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  if (scenesMet.length) console.log(`Кинематографические сцены по пути (ADR-0037): ${scenesMet.join('; ')}`);
} finally {
  await ctx.close();
  await browser.close();
}

if (RECORD) {
  const tmp = join(OUT, 'video-tmp');
  const file = readdirSync(tmp).find((f) => f.endsWith('.webm'));
  const webm = join(OUT, 'final-demo.webm');
  renameSync(join(tmp, file), webm);
  rmSync(tmp, { recursive: true, force: true });
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', join(OUT, 'final-demo.mp4')]);
    console.log(`✓ ${webm} и final-demo.mp4`);
  } catch {
    console.log(`✓ ${webm} (ffmpeg не найден — mp4 не создан)`);
  }
}
