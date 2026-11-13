/**
 * Records the 90-second kingdom scenario as a video — the fallback for the demo
 * day if the live laptop fails (docs/demo/kingdom-90s.md). One browser tab,
 * the persona switches through the demo sign-in, a caption names each step.
 * Needs a freshly seeded demo database and the demo server:
 *   npm run demo:record      → .demo/kingdom-demo.webm (+ .mp4 if ffmpeg is installed)
 */
import { chromium } from 'playwright';
import { signIn as pickCharacter } from './sign-in.mjs';
import { readFileSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const OUT = process.env.OUT ?? '.demo';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(OUT, 'video-tmp'), { recursive: true });
const browser = schematic(await chromium.launch());
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: join(OUT, 'video-tmp'), size: { width: 1280, height: 800 } } });
const page = await ctx.newPage();

/** A caption bar at the top of the page: what happens and who acts. */
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
/** This script always records: scenes play to their end. */
const RECORD = true;
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
  await caption(text);
  await pause(900);
  await pickCharacter(page, person);
  await page.waitForSelector('.shell');
  await passScene(person.name);
  await caption(text);
}
const go = async (hash, text) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await pause(700);
  if (text) await caption(text);
};
const typeIn = async (locator, text) => { await locator.click(); await locator.pressSequentially(text, { delay: 8 }); };

try {
  const storekeeper = by('Кладовщик');
  await signIn(storekeeper, '1. Кладовщик Асель предлагает улучшение');
  await go('#/kingdom', '1. Замок склада сейчас: уровень 2 «Крепость», 150 XP');
  await page.locator('.realm-list button', { hasText: 'Склад и логистика' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(3500);
  await go('#/new', '1. Идея своими словами');
  await page.getByRole('button', { name: 'Предложить улучшение' }).click();
  await typeIn(page.getByLabel(/Что сейчас не так/), 'Этикетку печатаем на отдельном компьютере и несём к паллете — 3–4 минуты на машину');
  await typeIn(page.getByLabel(/Что предлагаете/), 'Печатать этикетку со сканера на мобильный принтер у ворот');
  await typeIn(page.getByLabel('Коротко, одной строкой'), 'Печать этикеток со сканера у ворот');
  await page.getByLabel('Тема').selectOption({ label: 'ИТ и инструменты' });
  await pause(800);
  await page.getByRole('button', { name: 'Отправить обращение' }).click();
  await page.waitForURL(/#\/items\/\d+/);
  const n = Number(page.url().split('/').pop());
  await caption(`1. Обращение №${n}: ответственный и срок назначены сразу`);
  await pause(3000);
  await go('#/kingdom', `2. Посол «Обращение №${n}» вышел из замка склада`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await pause(4000);

  await signIn(by('Начальник склада'), '3. Совет: начальник склада — аргумент за');
  await go(`#/council/${n}`);
  await typeIn(page.getByLabel('Ваш довод'), 'Сэкономим около часа в день на приёмке');
  await page.getByRole('button', { name: 'Добавить аргумент' }).click();
  await pause(2500);

  await signIn(by('Сервисный инженер'), '3. Совет: сервисный инженер — аргумент против');
  await go(`#/council/${n}`);
  await page.getByRole('radio', { name: 'Аргумент против' }).click();
  await typeIn(page.getByLabel('Ваш довод'), 'Нужен запасной принтер, иначе встанет приёмка');
  await page.getByRole('button', { name: 'Добавить аргумент' }).click();
  await pause(2500);

  await signIn(by('Руководитель ИТ-разработки'), '4. Ведущий рекомендует внедрить и передаёт решение');
  await go(`#/council/${n}`);
  await page.getByRole('radio', { name: 'Рекомендация' }).click();
  await page.getByLabel('Рекомендация', { exact: true }).selectOption('implement');
  await typeIn(page.getByLabel('Обоснование'), 'Принтеры есть на складе, нужна только настройка');
  await page.getByRole('button', { name: 'Записать рекомендацию' }).click();
  await pause(1800);
  await page.getByRole('button', { name: 'Передать на решение' }).click();
  await page.locator('form.council-form').getByRole('button', { name: 'Передать на решение' }).click();
  await pause(2500);

  const ops = by('Операционный директор');
  await signIn(ops, '5. Решает ответственный: операционный директор');
  await go(`#/council/${n}`);
  await pause(2500);
  await page.getByRole('button', { name: 'Принять решение' }).first().click();
  await typeIn(page.getByLabel('Почему внедряем'), 'Совет за, риск закрываем запасным принтером');
  const itLead = by('Руководитель ИТ-разработки');
  const opt = (await page.getByLabel('Кто внедряет').locator('option', { hasText: itLead.name }).first().textContent())?.trim();
  await page.getByLabel('Кто внедряет').selectOption({ label: opt });
  await page.locator('form.council-form button[type=submit]').click();
  await pause(3000);

  await signIn(itLead, '6. Исполнитель внедряет и подтверждает результат');
  await go(`#/items/${n}`);
  await page.getByRole('button', { name: 'Сообщить о ходе работ' }).click();
  await typeIn(page.getByLabel('Что сделано и что дальше'), 'Сканеры настроены, принтеры у ворот №1 и №2');
  await page.getByRole('button', { name: 'Отправить отчёт' }).click();
  await pause(1500);
  await page.getByRole('button', { name: 'Отметить как реализовано' }).click();
  await typeIn(page.getByLabel('Что внедрено'), 'Этикетки печатаются у ворот');
  await page.locator('form.composer').getByRole('button', { name: 'Отметить как реализовано' }).click();
  await caption('7. Внедрение подтверждено: база начислила замку склада +100 XP');
  await pause(3500);

  await signIn(storekeeper, '8. Замок склада: 250 XP — новый уровень «Цитадель»');
  await go('#/kingdom');
  await page.locator('.realm-list button', { hasText: 'Склад и логистика' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await caption('8. Замок склада: 250 XP — новый уровень «Цитадель»');
  await pause(4500);
  await page.locator('.xp-history').scrollIntoViewIfNeeded();
  await caption('8. В истории замка — какое обращение подняло уровень и чей это вклад');
  await pause(3500);

  await signIn(ops, '9. Ответственный подтверждает эффект: до +50 XP, один раз');
  await go(`#/items/${n}`);
  await page.getByRole('button', { name: 'Подтвердить эффект' }).click();
  await page.getByLabel(/Бонус, XP/).fill('50');
  await typeIn(page.getByLabel('Что подтверждено и каким документом'), 'Хронометраж недели: приёмка быстрее на 4 минуты');
  await page.getByRole('button', { name: /Подтвердить эффект: \+50 XP/ }).click();
  await pause(3000);

  await signIn(by('Собственник компании'), '10. Рейтинг подразделений обновился');
  await go('#/rating');
  await pause(5000);
  await caption('Все люди и данные вымышлены. Опыт — только за подтверждённые события.');
  await pause(2500);
} finally {
  await ctx.close();
  await browser.close();
}

const tmp = join(OUT, 'video-tmp');
const file = readdirSync(tmp).find((f) => f.endsWith('.webm'));
const webm = join(OUT, 'kingdom-demo.webm');
renameSync(join(tmp, file), webm);
rmSync(tmp, { recursive: true, force: true });
console.log(`✓ ${webm}`);
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', join(OUT, 'kingdom-demo.mp4')]);
  console.log(`✓ ${join(OUT, 'kingdom-demo.mp4')}`);
} catch {
  console.log('ffmpeg не найден: оставлен только .webm');
}
