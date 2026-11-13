/**
 * Cinematic notifications through the real UI and the real server (ADR-0037).
 *
 * Part 1 — real facts, one device: the storekeeper sends an envoy (scene «Ваш посол отправлен»),
 * the King receives it («к вам прибыл посол», without the «Милорд» voice for a person who chose
 * another address) and accepts it in «Королевские послания», the storekeeper sees «Король принял
 * вашего посла»; the operations director calls a council (scene «Вас приглашают…»), then cancels it
 * (a plain text notice, no scene). Nothing replays after a reload; watching changes nothing.
 *
 * Part 1b (ADR-0042): the Great Round Table session starts («Великий Совет собран!» → «Войти в
 * заседание»); the warehouse head confirms the storekeeper's contribution in the item passport, she
 * sees «Ваш вклад признан»; no XP, no stage change.
 *
 * Part 2 — controls and failures on FIXTURE notifications injected into the reader's own feed
 * (marked `fixture-`): «Сейчас», «Позже», «Пропустить», a batch with «Дальше» and only the next
 * scene preloaded, a missing and a broken video, sound blocked by the browser, «облегчённая
 * графика», reduced motion, a phone, switched off, business wording.
 *
 * Needs a freshly seeded demo database and the demo server:
 *   npm run demo:seed && npm run demo:start  →  npm run demo:cinematics
 */
import { chromium } from 'playwright';
import { signIn as pickCharacter } from './sign-in.mjs';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const ORG = 'modus-demo';
const SHOTS = process.env.SHOTS;
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const king = by('Собственник компании');
const ops = by('Операционный директор');

const loud = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const strict = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const DESK = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function device(browser = loud, opts = DESK) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.mp4 = [];
  page.on('request', (r) => {
    if (r.url().includes('/cinematics/') && r.url().endsWith('.mp4')) page.mp4.push(new URL(r.url()).pathname);
  });
  await page.goto(BASE);
  await page.evaluate(() => localStorage.setItem('modus.lite', '0'));
  return { ctx, page };
}
async function signIn(page, person) {
  await page.evaluate(() => sessionStorage.removeItem('modus.token'));
  await page.goto(`${BASE}/#/`);
  await page.reload();
  await pickCharacter(page, person);
  await page.waitForSelector('.shell');
}
const api = (page, path, init) =>
  page.evaluate(
    async ({ path, init }) => {
      const r = await fetch(`/api/v1/orgs/modus-demo${path}`, {
        method: init?.method ?? 'GET',
        headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}`, 'content-type': 'application/json' },
        body: init?.json ? JSON.stringify(init.json) : undefined,
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(body)}`);
      return body;
    },
    { path, init },
  );
const scene = (page) => page.locator('dialog.cine[open]');
const video = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('dialog.cine[open] video');
    return v ? { src: new URL(v.currentSrc || v.src).pathname, muted: v.muted, paused: v.paused, time: v.currentTime, ended: v.ended } : null;
  });
const ledger = (page, membershipId) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{"seen":{}}').seen, `modus.cine.seen.${ORG}.${membershipId}`);
const me = (page) => page.evaluate(async () => (await (await fetch('/api/v1/me', { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } })).json()).memberships[0].membershipId);
async function waitScene(page, src, timeout = 20000) {
  await scene(page).waitFor({ timeout });
  await page.waitForFunction((src) => {
    const v = document.querySelector('dialog.cine[open] video');
    return v && new URL(v.currentSrc || v.src).pathname === src && v.currentTime > 0.3;
  }, src, { timeout: 20000 });
}
const quiet = async (page, ms = 2500) => {
  await page.waitForTimeout(ms);
  return (await page.locator('dialog.cine[open], .cine-text').count()) === 0;
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

try {
  // ---------------------------------------------------------------------------------------------
  // Part 1. Real facts on one device.
  // ---------------------------------------------------------------------------------------------
  const { ctx, page } = await device();
  await signIn(page, storekeeper);
  const storeId = await me(page);
  must(await quiet(page), 'the seeded history is not replayed on a new device');
  must(page.mp4.length === 0, 'no video is fetched while nothing is shown');
  step('новое устройство: история из сида не проигрывается, ни один ролик не скачан');

  // The storekeeper sends an envoy from one of her own open items.
  await page.goto(`${BASE}/#/`);
  await page.locator('a.list-row').first().waitFor({ timeout: 15000 });
  const links = await page.locator('.list-row a, a.list-row').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')).filter((h) => /#\/items\/\d+$/.test(h)))]);
  let number = null;
  for (const href of links) {
    await page.goto(`${BASE}/${href}`);
    const send = page.getByRole('button', { name: 'Отправить посла Королю' });
    if (await send.waitFor({ timeout: 6000 }).then(() => true, () => false)) {
      number = Number(href.split('/').pop());
      await send.click();
      break;
    }
  }
  must(number, 'the storekeeper has an open item to send an envoy with');
  await waitScene(page, '/cinematics/envoy-sent.mp4');
  must((await scene(page).locator('h2').innerText()) === 'Посол отправлен', 'the envoy-sent title');
  const sent = await video(page);
  must(!sent.muted && !sent.paused, `plays with its voice when the browser allows it: ${JSON.stringify(sent)}`);
  must(await scene(page).getByRole('button', { name: 'Пропустить' }).isVisible(), '«Пропустить» is there while it plays');
  await shot(page, '01-envoy-sent');
  await scene(page).getByRole('button', { name: 'Пропустить' }).click();
  must(await quiet(page, 800), '«Пропустить» closes at once');
  const audId = (await api(page, '/audiences')).items.find((a) => a.ideaNumber === number && a.role === 'sender').id;
  must((await ledger(page, storeId))[`a:${audId}:requested`] === 'skipped', 'written down as skipped');
  must(JSON.stringify(page.mp4) === JSON.stringify(['/cinematics/envoy-sent.mp4']) || page.mp4.every((p) => p === '/cinematics/envoy-sent.mp4'), `only this scene was fetched: ${page.mp4}`);
  await page.reload();
  await page.waitForSelector('.shell');
  must(await quiet(page, 3000), 'a reload does not replay it');
  step('отправка посла: сцена «Ваш посол отправлен» со звуком, «Пропустить», загружен только этот ролик, после перезагрузки не повторяется');

  // The King: the envoy arrives; the voice says «Милорд», he chose another address → no voice.
  await signIn(page, king);
  await waitScene(page, '/cinematics/envoy-arrived.mp4');
  const arrived = await video(page);
  must(arrived.muted, 'the «Милорд» voice is not played to a person who chose another form of address');
  must((await scene(page).innerText()).includes('Сцена без голоса'), 'and the scene says why');
  must((await scene(page).getByRole('button', { name: /Звук/ }).count()) === 0, 'no switch can force that voice on');
  await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
  const go = scene(page).getByRole('button', { name: 'Принять в посланиях' });
  must(await go.evaluate((b) => b === document.activeElement), 'after the scene the way forward has focus');
  await shot(page, '02-envoy-arrived');
  await go.click();
  await page.waitForFunction(() => location.hash === '#/inbox');
  must((await api(page, '/audiences')).items.find((a) => a.id === audId).status === 'requested', 'watching the scene accepted nothing');
  await page.getByRole('button', { name: 'Принять посла' }).first().click();
  await page.waitForFunction(async (id) => {
    const r = await fetch('/api/v1/orgs/modus-demo/audiences', { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } });
    return (await r.json()).items.find((a) => a.id === id)?.status === 'accepted';
  }, audId, { timeout: 15000 });
  step('Король: «к вам прибыл посол» без голоса «Милорд» (выбрано другое обращение), переход в послания; принимает сам, кнопкой');

  // The storekeeper: the King accepted — which is not a decision on the item.
  await signIn(page, storekeeper);
  await waitScene(page, '/cinematics/envoy-accepted.mp4');
  const acceptedText = await scene(page).innerText();
  must(acceptedText.includes('Король принял вашего посла') && acceptedText.includes('не решение'), 'accepting the envoy is said not to be a decision');
  await scene(page).getByRole('button', { name: 'Открыть обращение' }).click();
  await page.waitForFunction((n) => location.hash === `#/items/${n}`, number);
  const item = await api(page, `/ideas/${number}`);
  must(!['closed', 'adoption'].includes(item.stage), 'the item is where it was: no decision came from the scene');
  await page.goto(`${BASE}/#/inbox`);
  await page.locator('.audience-inbox').waitFor();
  must((await page.locator('.audience-screen').count()) === 0, 'the drawn audience scene in the inbox does not tell the same fact again');
  step('отправитель: «Король принял вашего посла» → «Открыть обращение»; статус обращения не изменился; сцена в посланиях не дублируется');

  // A council: invitation → scene; cancellation → plain text, no scene.
  await signIn(page, ops);
  const meeting = await api(page, '/meetings', { method: 'POST', json: { title: 'Сверка приёмки у ворот', participants: [storeId], organizerConsent: true } });
  await signIn(page, storekeeper);
  await waitScene(page, '/cinematics/council-invitation.mp4');
  must((await scene(page).locator('h2').innerText()).length > 0, 'the server headline is shown');
  await shot(page, '03-council-invitation');
  await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
  await scene(page).getByRole('button', { name: 'Открыть заседание' }).click();
  await page.waitForFunction((id) => location.hash === `#/meetings/${id}`, meeting.id);
  must((await ledger(page, storeId))[(Object.keys(await ledger(page, storeId)).find((k) => k.startsWith('n:')))] === 'opened', 'written down as opened');
  await signIn(page, ops);
  await api(page, `/meetings/${meeting.id}/cancel`, { method: 'POST', json: { reason: 'Перенесли приёмку на следующую неделю' } });
  // Called and cancelled before she looks: only the cancellation, never the stale invitation.
  const second = await api(page, '/meetings', { method: 'POST', json: { title: 'Разбор возвратов', participants: [storeId], organizerConsent: true } });
  await api(page, `/meetings/${second.id}/cancel`, { method: 'POST', json: { reason: 'Вопрос снят' } });
  await signIn(page, storekeeper);
  const notice = page.locator('.cine-text');
  await notice.waitFor({ timeout: 20000 });
  must((await scene(page).count()) === 0, 'a cancelled council gets no scene, and its stale invitation is not played');
  must((await notice.getAttribute('role')) === 'status', 'the plain notice is announced politely and blocks nothing');
  // The page stays usable under the notice: the navigation is not covered.
  await page.locator('.rail a[href="#/kingdom"]').click({ trial: true });
  must((await notice.innerText()).includes('Дальше:'), 'the second cancellation waits behind «Дальше»');
  await shot(page, '04-meeting-cancelled');
  await notice.getByRole('button', { name: 'Закрыть' }).click();
  await notice.waitFor({ state: 'detached', timeout: 5000 });
  must(await quiet(page, 1500), '«Закрыть» ends the batch; the other cancellation stays in the inbox');
  step('Совет: приглашение → сцена → «Открыть заседание»; отмена → обычное текстовое уведомление без ролика; отменённое приглашение не проигрывается');
  await ctx.close();

  // ---------------------------------------------------------------------------------------------
  // Part 1b (ADR-0042, owner decisions 2026-11-13). «Великий Совет собран!» when the Great Round
  // Table session starts; «Ваш вклад признан» when an item's lead confirms her contribution.
  // ---------------------------------------------------------------------------------------------
  {
    const { ctx, page } = await device();
    const passAny = async () => {
      await page.waitForFunction(() => document.documentElement.dataset.cineChecked === '1', null, { timeout: 15000 });
      for (let i = 0; i < 4; i++) {
        const box = page.locator('dialog.cine[open], .cine-text');
        if (!(await box.count())) return;
        await box.getByRole('button', { name: /^(Пропустить|Позже|Закрыть)$/ }).first().click();
        await box.first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
      }
    };
    await signIn(page, storekeeper);
    must(await quiet(page, 1500), 'a new device starts quiet');

    // The Great Round Table: called (an invitation), everyone consents, the organizer starts the session.
    await signIn(page, ops);
    await passAny();
    const great = await api(page, '/meetings', { method: 'POST', json: { title: 'Большой Круглый стол: приёмка у ворот', participants: [storeId], organizerConsent: true } });
    await signIn(page, storekeeper);
    await waitScene(page, '/cinematics/council-invitation.mp4');
    await scene(page).getByRole('button', { name: 'Пропустить' }).click();
    await api(page, `/meetings/${great.id}/consent`, { method: 'POST', json: { consent: 'given' } });
    await api(page, `/meetings/${great.id}/attendance`, { method: 'POST', json: { attendance: 'confirmed' } });
    must(await quiet(page, 2500), 'consenting and confirming attendance announce nothing: the session has not started');
    await signIn(page, ops);
    await passAny();
    await api(page, `/meetings/${great.id}/recording/start`, { method: 'POST', json: {} });
    await signIn(page, storekeeper);
    await waitScene(page, '/cinematics/great-council-gathered.mp4');
    const g = await scene(page).innerText();
    must(g.length > 0, 'the server headline is shown');
    await shot(page, '10-great-council-gathered');
    await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
    await scene(page).getByRole('button', { name: 'Войти в заседание' }).click();
    await page.waitForFunction((id) => location.hash === `#/meetings/${id}`, great.id);
    await page.reload();
    await page.waitForSelector('.shell');
    must(await quiet(page, 2500), 'it plays once');
    step('Большой Круглый стол: приглашение → согласие (сцены нет) → организатор начал заседание → «Великий Совет собран!» → «Войти в заседание»; один раз');

    // A contribution of the storekeeper, confirmed by the lead of the item in the passport.
    const lead = by('Начальник склада');
    await signIn(page, lead);
    await passAny();
    let target = null;
    for (let n = 1; n <= 40 && !target; n++) {
      const it = await api(page, `/ideas/${n}`).catch(() => null);
      const c = it?.contributions?.find((x) => x.member === storekeeper.name && x.canConfirm);
      if (c) target = { n, c };
    }
    must(target, 'the warehouse head leads an item with a recorded contribution of the storekeeper');
    const stageBefore = (await api(page, `/ideas/${target.n}`)).stage;
    await signIn(page, storekeeper);
    const xpBefore = JSON.stringify((await api(page, '/me/contribution')).items.map((x) => [x.number, x.xp]));
    await signIn(page, lead);
    await passAny();
    await page.goto(`${BASE}/#/items/${target.n}`);
    const line = page.locator('.credit-line', { hasText: storekeeper.name });
    await line.getByRole('button', { name: 'Подтвердить вклад' }).click();
    must(await line.innerText().then((t) => t.includes('Отменить нельзя')), 'confirming asks once more: it cannot be undone');
    await shot(page, '11-confirm-contribution');
    await line.getByRole('button', { name: 'Да, подтвердить' }).click();
    await line.locator('.credit-confirmed').waitFor({ timeout: 10000 });
    must((await page.locator('.credit-line', { hasText: storekeeper.name }).getByRole('button', { name: 'Подтвердить вклад' }).count()) === 0, 'no second confirmation');
    await signIn(page, storekeeper);
    await waitScene(page, '/cinematics/contribution-recognized.mp4');
    must((await scene(page).innerText()).includes(String(target.n)) || (await scene(page).innerText()).length > 0, 'the server words');
    await shot(page, '12-contribution-recognized');
    await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
    await scene(page).getByRole('button', { name: 'Открыть обращение' }).click();
    await page.waitForFunction((n) => location.hash === `#/items/${n}`, target.n);
    const mine = page.locator('.credit-line', { hasText: storekeeper.name });
    await mine.locator('.credit-confirmed').waitFor({ timeout: 10000 });
    must((await mine.getByRole('button').count()) === 0, 'the contributor cannot confirm anything about her own contribution');
    must(JSON.stringify((await api(page, '/me/contribution')).items.map((x) => [x.number, x.xp])) === xpBefore, 'no XP from a confirmation');
    must((await api(page, `/ideas/${target.n}`)).stage === stageBefore, 'no stage change from a confirmation');
    step('вклад: ведущий подтверждает вклад кладовщика в паспорте (второй шаг: «отменить нельзя») → у неё «Ваш вклад признан» → «Открыть обращение», отметка «подтверждён»; XP и стадия не изменились');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------
  // Part 2. Controls and failures on fixture notifications (the reader's own feed + one fixture).
  // ---------------------------------------------------------------------------------------------
  let seq = 0;
  async function withFixture(page, fixtures) {
    await page.unroute('**/api/v1/orgs/*/notifications').catch(() => undefined);
    await page.route('**/api/v1/orgs/*/notifications', async (route) => {
      const res = await route.fetch();
      const list = await res.json();
      await route.fulfill({ response: res, json: [...fixtures, ...list] });
    });
  }
  const fixture = (event, extra = {}) => ({
    id: `fixture-${event}-${++seq}`,
    event,
    category: 'items',
    message: `Тестовое уведомление ${event}`,
    royal: null,
    headline: `Тест: ${event}`,
    urgent: ['deadline_soon', 'assigned', 'council_handoff'].includes(event),
    ideaNumber: 2,
    meetingId: null,
    knowledgeId: null,
    meeting: null,
    meetingClosed: false,
    createdAt: new Date(Date.now() + 1000).toISOString(),
    readAt: null,
    ...extra,
  });
  async function fresh(browser = loud, opts = DESK, before) {
    const d = await device(browser, opts);
    if (before) await d.page.evaluate(before);
    await signIn(d.page, storekeeper);
    must(await quiet(d.page, 1500), 'a new device starts quiet');
    return d;
  }

  {
    const { ctx, page } = await fresh();
    const id = await me(page);
    const later = fixture('deadline_soon');
    await withFixture(page, [later]);
    await page.reload();
    await waitScene(page, '/cinematics/notification.mp4');
    must(await scene(page).getByRole('button', { name: 'Сейчас' }).isVisible(), '«Сейчас»');
    must(await scene(page).getByRole('button', { name: 'Позже' }).isVisible(), '«Позже»');
    must((await scene(page).getByRole('button', { name: 'Пропустить' }).count()) === 0, 'the prompt asks, it does not offer «Пропустить»');
    await shot(page, '05-prompt');
    await scene(page).getByRole('button', { name: 'Позже' }).click();
    must(await quiet(page, 800), '«Позже» closes');
    must((await ledger(page, id))[`n:${later.id}`] === 'later', '«Позже» is written down');
    await page.reload();
    must(await quiet(page, 2500), '«Позже» does not come back by itself; the notice stays in the inbox');
    const now = fixture('council_handoff');
    await withFixture(page, [now]);
    await page.reload();
    await waitScene(page, '/cinematics/notification.mp4');
    await scene(page).getByRole('button', { name: 'Сейчас' }).click();
    await page.waitForFunction(() => location.hash === '#/items/2');
    must((await ledger(page, id))[`n:${now.id}`] === 'opened', '«Сейчас» opens the item and is written down');
    step('общее уведомление: «Сейчас» открывает связанное обращение, «Позже» закрывает и не возвращается само');

    // A batch: the most urgent first, «Дальше», and only the next scene fetched ahead.
    const batch = [fixture('knowledge_in_library', { ideaNumber: null, knowledgeId: null }), fixture('assigned'), fixture('changes_requested')];
    await withFixture(page, batch);
    page.mp4.length = 0;
    await page.reload();
    await waitScene(page, '/cinematics/assignment.mp4');
    await page.waitForTimeout(800);
    const fetched = [...new Set(page.mp4)];
    must(fetched.length === 2 && fetched.includes('/cinematics/assignment.mp4') && fetched.includes('/cinematics/changes-requested.mp4'), `the current and only the next scene are fetched: ${fetched}`);
    await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
    await scene(page).getByRole('button', { name: /^Дальше: Тест: changes_requested \(ещё 2\)$/ }).click();
    await waitScene(page, '/cinematics/changes-requested.mp4');
    await scene(page).getByRole('button', { name: 'Пропустить' }).click();
    must(await quiet(page, 1500), '«Пропустить» ends the batch: the rest waits in the inbox');
    const seen = await ledger(page, id);
    must(seen[`n:${batch[1].id}`] === 'played' && seen[`n:${batch[2].id}`] === 'skipped' && seen[`n:${batch[0].id}`] === 'batched', `outcomes: ${JSON.stringify(seen)}`);
    step('пачка: сначала то, что требует действия; заранее загружена только следующая сцена; «Дальше», затем «Пропустить» — остальное ждёт в уведомлениях');

    // A missing video and a broken one: the ordinary notice instead, nothing hangs.
    await page.route('**/cinematics/castle-level-up.mp4', (r) => r.fulfill({ status: 404, body: 'no' }));
    await page.route('**/cinematics/implementation-approved.mp4', (r) => r.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('not a video at all') }));
    for (const [event, label] of [['castle_level_up', 'отсутствует'], ['idea_merged', 'повреждён']]) {
      const f = fixture(event);
      await withFixture(page, [f]);
      await page.reload();
      await scene(page).waitFor({ timeout: 20000 });
      await page.locator('dialog.cine[data-mode="failed"]').waitFor({ timeout: 12000 });
      const t = await scene(page).innerText();
      must(t.includes('Сцену не удалось показать') && t.includes(f.headline), `${label}: the notice itself is shown`);
      if (event === 'castle_level_up') await shot(page, '06-failed');
      await scene(page).getByRole('button', { name: 'Закрыть' }).click();
      must((await ledger(page, id))[`n:${f.id}`] === 'failed', `${label}: written down as failed`);
    }
    step('ролик отсутствует (404) или повреждён: показывается само уведомление, записано «failed»');

    // Switched off, then business wording: nothing plays, nothing replays later.
    await page.goto(`${BASE}/#/me`);
    await page.getByRole('button', { name: 'Кинематографические уведомления: вкл' }).click();
    const off = fixture('assigned');
    await withFixture(page, [off]);
    await page.reload();
    must(await quiet(page, 3000), 'switched off: no scene');
    must((await ledger(page, id))[`n:${off.id}`] === 'batched', 'but the fact is written down, so switching on does not replay it');
    await page.goto(`${BASE}/#/me`);
    await page.getByRole('button', { name: 'Кинематографические уведомления: выкл' }).click();
    await page.reload();
    must(await quiet(page, 2500), 'switched on again: the old fact stays quiet');
    await api(page, '/me/notification-preferences', { method: 'PUT', json: { style: 'business', addressForm: 'title', groupRepeats: true, muted: [] } }).catch(async () => {
      await page.goto(`${BASE}/#/me`);
    });
    await withFixture(page, [fixture('assigned')]);
    await page.reload();
    must(await quiet(page, 3000), 'business wording: no game scenes');
    await api(page, '/me/notification-preferences', { method: 'PUT', json: { style: 'royal', addressForm: 'title', groupRepeats: true, muted: [] } });
    step('выключено в профиле — сцен нет и после включения старое не проигрывается; деловой стиль посланий — сцен нет');
    await ctx.close();
  }

  // Sound blocked by the browser: plays silently, offers «Включить звук». Browsers differ in what
  // counts as a gesture (the sign-in click may unlock sound for the site), so the policy is set
  // explicitly: sound without a click on this page is refused with NotAllowedError, as they do.
  {
    const { ctx, page } = await fresh(strict);
    await ctx.addInitScript(() => {
      let clicked = false;
      addEventListener('pointerdown', () => (clicked = true), true);
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!this.muted && !clicked) return Promise.reject(new DOMException('play() without a user gesture', 'NotAllowedError'));
        return play.call(this);
      };
    });
    await withFixture(page, [fixture('assigned')]);
    await page.reload();
    await waitScene(page, '/cinematics/assignment.mp4');
    const v = await video(page);
    must(v.muted && !v.paused, `blocked sound: the scene plays silently: ${JSON.stringify(v)}`);
    const unmute = scene(page).getByRole('button', { name: 'Включить звук' });
    must(await unmute.isVisible(), '«Включить звук» is offered');
    await shot(page, '07-sound-blocked');
    await unmute.click();
    await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.muted === false, null, { timeout: 5000 });
    await page.keyboard.press('Escape');
    must(await quiet(page, 800), 'Esc closes the scene like «Пропустить»');
    step('браузер запретил звук без жеста: сцена идёт без звука, кнопка «Включить звук» возвращает голос; Esc закрывает сцену');
    await ctx.close();
  }

  // «Облегчённая графика» and reduced motion: a still frame, no video fetched.
  for (const [label, opts, before] of [
    ['облегчённая графика', DESK, () => localStorage.setItem('modus.lite', '1')],
    ['уменьшить движение', { ...DESK, reducedMotion: 'reduce' }, null],
  ]) {
    const { ctx, page } = await fresh(loud, opts, before);
    if (before) await page.evaluate(before);
    await withFixture(page, [fixture('assigned')]);
    page.mp4.length = 0;
    await page.reload();
    await scene(page).waitFor({ timeout: 20000 });
    must((await scene(page).locator('video').count()) === 0 && (await scene(page).locator('img.cine-media').count()) === 1, `${label}: a still frame instead of the video`);
    must(page.mp4.length === 0, `${label}: no video is fetched`);
    if (label === 'уменьшить движение') await shot(page, '08-still');
    await scene(page).getByRole('button', { name: 'Закрыть' }).click();
    step(`${label}: неподвижный кадр вместо ролика, видео не скачивается`);
    await ctx.close();
  }

  // A phone: the scene fills the screen, every control is a finger-size target.
  {
    const { ctx, page } = await fresh(loud, PHONE);
    await withFixture(page, [fixture('assigned')]);
    await page.reload();
    await waitScene(page, '/cinematics/assignment.mp4');
    const box = await scene(page).boundingBox();
    must(box.width >= 388 && box.height >= 800, `the scene fills the phone screen: ${JSON.stringify(box)}`);
    const frame = await scene(page).locator('.cine-frame').boundingBox();
    must(frame.height > 400, 'the vertical video takes most of the height');
    for (const b of await scene(page).getByRole('button').all()) {
      const r = await b.boundingBox();
      must(r.height >= 44, `touch target: ${JSON.stringify(r)}`);
    }
    must((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, 'no horizontal scroll');
    await shot(page, '09-phone');
    await scene(page).getByRole('button', { name: 'Пропустить' }).click();
    step('телефон 390×844: сцена на весь экран, все кнопки не меньше 44 px, без горизонтальной прокрутки');
    await ctx.close();
  }

  must(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  console.log(`\nКинематографические уведомления проверены за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await loud.close();
  await strict.close();
}
