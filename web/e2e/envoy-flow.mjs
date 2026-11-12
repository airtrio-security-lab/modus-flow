/**
 * «Путь Посла» (ADR-0032) through the real UI, desktop and phone, on freshly seeded demo data (fictional people):
 *
 *   the storekeeper opens the app → a recorded rank-up waits for her and can be skipped at once →
 *   she files a problem and her envoy walks on the map in her rank's attire, with 0 XP for filing →
 *   her earlier item is implemented and its effect is measured and approved by the people who hold that
 *   right → the server raises her envoy to rank III; the card «Ваш посол достиг ранга …!» appears after
 *   the next login, does not block the navigation and leads to «Мой посол» with the basis of every line →
 *   the map shows the new attire → her rights are what they were → the phone layout, the light mode and
 *   prefers-reduced-motion hold.
 *
 *   npm run demo:envoy     (needs a freshly seeded demo server; SHOTS=dir saves screenshots)
 * Workflow steps that existed before (measurement, implementation, approval) go through the same API the
 * UI uses, as the people who have those rights; everything new is checked on the screen.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const itLead = by('Руководитель ИТ-разработки');
const analyst = by('Системный аналитик');
const ops = by('Операционный директор');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, message) => { if (!cond) throw new Error(message); };

async function open(person, { viewport = { width: 1280, height: 860 }, lite = true, ...extra } = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate((l) => { try { localStorage.setItem('modus.lite', l ? '1' : '0'); localStorage.setItem('modus.howto.hidden', '1'); } catch {} }, lite);
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  const call = (method, path, body) =>
    page.evaluate(async ({ method, path, body }) => {
      const r = await fetch('/api/v1/orgs/modus-demo' + path, {
        method,
        headers: { authorization: 'Bearer ' + sessionStorage.getItem('modus.token'), ...(body ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, body: text ? JSON.parse(text) : null };
    }, { method, path, body });
  const ok = async (method, path, body) => {
    const r = await call(method, path, body);
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const hash = async (h) => { await page.evaluate((x) => (location.hash = x), h); await page.waitForTimeout(250); };
  const shot = async (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }) : undefined);
  return { ctx, page, call, ok, hash, shot };
}
const noSideScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);

try {
  // ---- 1. A rank-up recorded earlier waits after login; «Пропустить» closes it at once and for good ----
  let a = await open(storekeeper);
  const card = a.page.locator('.envoy-rankup');
  await card.waitFor({ timeout: 8000 });
  must((await card.innerText()).includes('Ваш посол достиг ранга Вестника!'), 'the recorded rank II is announced by its name');
  await a.shot('01-rankup-waiting');
  const before = await a.ok('GET', '/me/envoy');
  await card.getByRole('button', { name: 'Пропустить' }).click();
  await card.waitFor({ state: 'detached', timeout: 3000 });
  await a.page.reload();
  await a.page.waitForSelector('.shell');
  await a.page.waitForTimeout(800);
  must((await a.page.locator('.envoy-rankup').count()) === 0, 'a skipped rank-up does not come back');
  const afterSkip = await a.ok('GET', '/me/envoy');
  must(afterSkip.xp === before.xp && afterSkip.rank === before.rank && afterSkip.pending === null, 'watching or skipping awards nothing');
  step(`кладовщик: карточка «Ваш посол достиг ранга Вестника!» ждала после входа и закрылась «Пропустить» (XP ${afterSkip.xp}, ранг ${afterSkip.rank})`);

  // ---- 2. She files a problem: the envoy appears on the map in her rank's attire; filing brings 0 XP ----
  await a.hash('#/new');
  const kind = a.page.getByLabel('Проблема', { exact: false }).first();
  if (await kind.count()) await kind.check().catch(() => undefined);
  await a.page.locator('#title').fill('Стеллаж у ворот №3 мешает погрузчику (учебный пример)');
  await a.page.locator('#problem').fill('Погрузчик не разворачивается у ворот №3: стеллаж стоит слишком близко. Пример учебный.');
  const proposal = a.page.locator('#proposal');
  if (await proposal.count()) await proposal.fill('Перенести стеллаж на полтора метра к стене.');
  await a.page.getByRole('button', { name: /^Отправить/ }).click();
  await a.page.waitForFunction(() => /#\/items\/\d+/.test(location.hash), null, { timeout: 15000 });
  const n = Number(/#\/items\/(\d+)/.exec(await a.page.evaluate(() => location.hash))[1]);
  await a.hash('#/kingdom');
  const mark = a.page.locator(`.realm-envoy:has(a[href="#/items/${n}"])`);
  await mark.waitFor({ timeout: 10000 });
  must((await mark.getAttribute('data-envoy-rank')) === String(before.rank), 'the envoy is dressed by the sender’s rank');
  const tip = await mark.locator('title').textContent();
  must(tip.includes(`Обращение №${n}`) && tip.includes(storekeeper.name) && tip.includes('ранг II, Вестник') && tip.includes('Статус:') && tip.includes('Подразделение:'), `hover names the sender, rank, department, number and status: ${tip}`);
  must((await mark.locator(`.env-fig[data-civ="kazakh"]`).count()) === 1, 'her department’s style (Казахское ханство) dresses the envoy');
  must((await a.ok('GET', '/me/envoy')).xp === before.xp, 'filing an item brings 0 XP');
  await mark.scrollIntoViewIfNeeded();
  await a.shot('02-envoy-on-map');
  step(`обращение №${n} подано: посол на карте в одеянии ранга II (Казахское ханство), XP не изменился`);
  await a.ctx.close();

  // ---- 3. Her item №2 (already decided): measured, implemented, effect approved — by the people with those rights ----
  const lead = await open(itLead);
  const plan = { plan: 'Сравнить время приёмки до и после (учебный пример)', successCriteria: 'Приёмка быстрее', owner: analyst.membershipId ?? null };
  if (!plan.owner) {
    const dir = await lead.ok('GET', '/directory');
    plan.owner = dir.members.find((m) => m.name === analyst.name).membershipId;
  }
  const v = (await lead.ok('POST', '/ideas/2/impact-verifications', plan)).id;
  const measurer = await open(analyst);
  await measurer.ok('POST', `/ideas/2/verifications/${v}/evidence`, { kind: 'baseline', body: 'Октябрь, учебные данные', metric: 'Время приёмки партии', value: 42, unit: 'мин', goal: 'decrease' });
  await lead.ok('POST', '/ideas/2/implementation', { report: 'Терминалы обновлены, работают с понедельника (учебный пример)' });
  const mid = await lead.ok('GET', `/people/${(await lead.ok('GET', '/directory')).members.find((m) => m.name === storekeeper.name).membershipId}/envoy`);
  must(mid.xp === before.xp + 20 && mid.rank === 2, `a confirmed implementation: +20, still rank II (${mid.xp})`);
  await measurer.ok('POST', `/ideas/2/verifications/${v}/evidence`, { kind: 'result', body: 'Ноябрь, те же смены, учебные данные', metric: 'Время приёмки партии', value: 30, unit: 'мин', comparable: true });
  await lead.ok('POST', `/ideas/2/verifications/${v}/conclusion`, { outcome: 'positive', conclusion: 'Приёмка партии быстрее на 12 минут при тех же сменах' });
  await measurer.ctx.close();
  await lead.ctx.close();
  const owner = await open(ops);
  await owner.ok('POST', '/ideas/2/effect', { xp: 30, rationale: 'Время приёмки сократилось, подтверждено сопоставимым замером' });
  await owner.ctx.close();
  step('обращение №2: замер «до/после», внедрение подтверждено, эффект одобрен ответственным за решение');

  // ---- 4. Next login: the card announces rank III, does not block the navigation, leads to «Мой посол» ----
  a = await open(storekeeper, { lite: false });
  const up = a.page.locator('.envoy-rankup');
  await up.waitFor({ timeout: 8000 });
  must((await up.innerText()).includes('Ваш посол достиг ранга Доверенного посланника!'), 'the rank actually reached is named');
  await a.page.waitForTimeout(1800);
  await a.shot('03-rankup-iii');
  await a.page.locator('.rail a[href="#/kingdom"], .tabbar a[href="#/kingdom"]').first().click();
  await a.page.waitForFunction(() => location.hash.startsWith('#/kingdom'));
  must((await a.page.locator('.envoy-rankup').count()) === 1, 'navigation works while the card is shown');
  await up.getByRole('link', { name: 'Открыть карточку посла' }).click();
  await a.page.waitForSelector('#person-envoy');
  await a.page.locator('.envoy-rankup').waitFor({ state: 'detached', timeout: 4000 });
  const section = await a.page.locator('#person-envoy').innerText();
  must(section.includes('Мой посол') && section.includes('Доверенный посланник'), 'the profile shows the new rank');
  must(section.includes('+30 XP — подтверждён измеримый положительный эффект обращения №2') && section.includes('+20 XP — подтверждено внедрение обращения №2'), 'every line names its basis');
  must((await a.page.locator('.envoy-ladder li.is-reached').count()) === 3, 'three ranks reached, with dates');
  await a.page.locator('#person-envoy').scrollIntoViewIfNeeded();
  await a.shot('04-my-envoy');
  step('после входа: «Ваш посол достиг ранга Доверенного посланника!», навигация не заблокирована, «Мой посол» с основаниями');

  // ---- 5. The map shows the new attire; the walk is animated in the full mode ----
  await a.hash('#/kingdom');
  const walker = a.page.locator(`.realm-envoy:has(a[href="#/items/${n}"])`);
  await walker.waitFor();
  must((await walker.getAttribute('data-envoy-rank')) === '3', 'the map shows rank III');
  must((await walker.locator('.env-fig.env-r3').count()) === 1, 'in the attire of rank III');
  const anim = await walker.locator('.env-leg-f').first().evaluate((el) => getComputedStyle(el).animationName);
  must(anim === 'env-step', `the envoy walks in the full mode (${anim})`);
  await walker.scrollIntoViewIfNeeded();
  await a.shot('05-envoy-rank-iii-on-map');
  // ---- 6. A rank grants nothing: the same refusals as before ----
  const me = await a.call('GET', '/me/envoy');
  const decide = await a.call('POST', '/ideas/8/decision', { outcome: 'merge', rationale: 'Посол третьего ранга пытается решить' });
  must(decide.status === 403 || decide.status === 404, `no decision power from a rank (${decide.status})`);
  const effect = await a.call('POST', '/ideas/9/effect', { xp: 10, rationale: 'Посол третьего ранга подтверждает эффект' });
  must(effect.status === 403 || effect.status === 404 || effect.status === 409, `no approval power from a rank (${effect.status})`);
  step(`карта: посол в одеянии ранга III; ранг ${me.body.rank} прав не дал (решение ${decide.status}, эффект ${effect.status})`);
  await a.ctx.close();

  // ---- 7. Phone 390×844: map and «Мой посол» without horizontal scrolling ----
  const phone = await open(storekeeper, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phone.hash('#/kingdom');
  await phone.page.locator('.realm-envoy').first().waitFor();
  must(await noSideScroll(phone.page), 'the map fits the phone');
  await phone.shot('06-phone-map');
  const myId = (await phone.ok('GET', '/me/envoy')).membershipId;
  await phone.hash(`#/people/${myId}?section=envoy`);
  await phone.page.waitForSelector('.envoy-ladder');
  must(await noSideScroll(phone.page), '«Мой посол» fits the phone');
  await phone.shot('07-phone-my-envoy');
  await phone.ctx.close();
  step('телефон 390×844: карта и «Мой посол» без горизонтальной прокрутки');

  // ---- 8. Light mode and prefers-reduced-motion: no movement, the attire is still shown ----
  for (const [name, opts] of [['облегчённый режим', { lite: true }], ['prefers-reduced-motion', { lite: false, reducedMotion: 'reduce' }]]) {
    const r = await open(storekeeper, opts);
    await r.hash('#/kingdom');
    const fig = r.page.locator(`.realm-envoy:has(a[href="#/items/${n}"]) .env-leg-f`).first();
    await fig.waitFor();
    const st = await fig.evaluate((el) => { const s = getComputedStyle(el); return { name: s.animationName, dur: parseFloat(s.animationDuration) }; });
    must(st.name === 'none' || st.dur === 0, `${name}: the envoy does not move (${st.name} ${st.dur})`);
    must((await r.page.locator(`.realm-envoy:has(a[href="#/items/${n}"]) .env-fig.env-r3`).count()) === 1, `${name}: the attire is shown`);
    await r.ctx.close();
    step(`${name}: движение выключено, одеяние на месте`);
  }

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`✓ Путь Посла: все шаги пройдены (${((Date.now() - t0) / 1000).toFixed(1)} с) — ЛОКАЛЬНО`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
