/**
 * «Как предложение инженера стало полезным методом для всей компании» — the hackathon story, end to end,
 * through the real UI and the real API (ADR-0038, ADR-0040, ADR-0041). Nothing is imitated in the
 * browser: every step is a request the server accepts or refuses, and every check reads the server.
 *
 * ALL DATA OF THIS SCENARIO IS SYNTHETIC AND LABELLED «учебный пример» IN ITS TEXT.
 *
 *    1  an engineer opens the city            9  the implementation and the effect are confirmed
 *    2  files a proposal                     10  the experience the rules provide is granted — once
 *    3  his envoy appears on the map         11  the solution reaches the Library
 *    4  the lead receives the item           12  another employee finds the method
 *    5  the Council discusses it             13  presses «Применить этот метод»
 *    6  the decision owner decides           14  creates a new item with a reference to the knowledge
 *    7  a pilot is measured                  15  and comes back to the map where they left it
 *    8  the evidence is recorded
 *
 *   npm run demo:living        (a seeded demo server; BASE / PERSONAS point at another one; SHOTS=dir saves pictures)
 * The 3D city runs on SwiftShader here: positions are checked, not speed.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const engineer = by('Сервисный инженер');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const analyst = by('Системный аналитик');
const archivist = by('Архивариус');
const storekeeper = by('Кладовщик');

const gl = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, message) => {
  if (!cond) throw new Error(message);
};

// A run of its own: the scenario can be repeated on the same database without tripping over itself.
const RUN = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
const TITLE = `Контрольный список сдачи оборудования (учебный пример ${RUN})`;
const METHOD = `Метод: контрольный список перед сдачей (учебный пример ${RUN})`;
const METRIC = 'Время подготовки к сдаче';

async function open(person, { view = 'city', viewport = { width: 1280, height: 820 }, mobile = false } = {}) {
  const ctx = await gl.newContext({ viewport, deviceScaleFactor: 1, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem('modus.kingdom.view', v);
      localStorage.setItem('modus.howto.hidden', '1');
      localStorage.setItem('modus.lite', '0');
      localStorage.setItem('modus.w3d.hint', '1');
      localStorage.setItem('modus.w3d.quality', 'low');
    } catch {
      /* storage unavailable */
    }
  }, view);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  const call = (method, path, body) =>
    page.evaluate(
      async ({ method, path, body }) => {
        const r = await fetch('/api/v1/orgs/modus-demo' + path, {
          method,
          headers: { authorization: 'Bearer ' + sessionStorage.getItem('modus.token'), ...(body ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
        return text ? JSON.parse(text) : null;
      },
      { method, path, body },
    );
  const refused = async (method, path, body) => call(method, path, body).then(() => false, () => true);
  const hash = async (h) => {
    await page.evaluate((x) => (location.hash = x), h);
    await page.waitForTimeout(200);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    await page.waitForFunction(() => !document.querySelector('.page[data-arrive]'), null, { timeout: 3000 }).catch(() => undefined);
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  };
  const world = async () => {
    await page.locator('.w3d').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
  };
  /** A cinematic notification may greet the person: it is closed like a person would close it, and changes nothing. */
  const dismissScene = async () => {
    const skip = page.locator('dialog.cine[open] button, .cine-text button').filter({ hasText: /Пропустить|Позже|Закрыть/ }).first();
    for (let i = 0; i < 4 && (await skip.isVisible().catch(() => false)); i++) {
      await skip.click().catch(() => undefined);
      await page.waitForTimeout(250);
    }
  };
  return { ctx, page, call, refused, hash, shot, world, dismissScene };
}
const near = (a, b, eps = 1) => ['x', 'z', 'dist'].every((k) => Math.abs(a[k] - b[k]) < eps) && Math.abs(a.az - b.az) < 0.02 && Math.abs(a.pol - b.pol) < 0.02;

try {
  // ---- 1–3. The engineer opens the city, files a proposal, and his envoy appears on the map ----
  let a = await open(engineer, { view: '3d' });
  await a.hash('#/kingdom');
  await a.world();
  await a.dismissScene();
  const xp0 = { envoy: (await a.call('GET', '/me/envoy')).xp, castles: Object.fromEntries((await a.call('GET', '/kingdom')).castles.map((c) => [c.id, c.xp])) };
  const envoysBefore = (await a.call('GET', '/kingdom')).envoys.map((e) => e.number);
  await a.shot('01-engineer-in-the-city');
  await a.hash('#/new');
  await a.page.getByRole('button', { name: 'Предложить улучшение' }).click();
  await a.page.locator('#problem').fill('При подготовке оборудования к сдаче повторяются одни и те же ошибки: забытые проверки и повторные выезды. Учебный пример, данные синтетические.');
  await a.page.locator('#proposal').fill('Ввести контрольный список подготовки к сдаче и проверить его на трёх объектах (учебный пример).');
  await a.page.locator('#title').fill(TITLE);
  await a.page.locator('#category').selectOption({ label: 'ИТ и инструменты' });
  await a.page.getByRole('button', { name: /^Отправить/ }).click();
  await a.page.waitForFunction(() => /#\/items\/\d+/.test(location.hash), null, { timeout: 15000 });
  const n = Number(/#\/items\/(\d+)/.exec(await a.page.evaluate(() => location.hash))[1]);
  must(n > 0 && !envoysBefore.includes(n), 'a new item is filed');
  let item = await a.call('GET', `/ideas/${n}`);
  must(item.author.name === engineer.name, 'the engineer is the author');
  step(`1–2. инженер открыл город и подал предложение №${n}`);

  await a.hash('#/kingdom');
  await a.world();
  const k1 = await a.call('GET', '/kingdom');
  must(k1.envoys.some((e) => e.number === n && e.mine), 'the server puts his envoy on the map');
  await a.page.locator(`button.w3d-envoy[aria-label^="Обращение №${n} "]`).waitFor({ state: 'attached', timeout: 20000 });
  await a.shot('02-envoy-on-the-map');
  step('3. посол появился на карте — из ответа сервера, а не из браузера');
  await a.ctx.close();

  // ---- 4–5. The lead receives the item; the Council discusses it ----
  const lead = await open(itLead);
  const inbox = await lead.call('GET', '/notifications');
  must(inbox.some((x) => x.ideaNumber === n && x.event === 'idea_published'), 'the lead has the notification of this very item');
  item = await lead.call('GET', `/ideas/${n}`);
  must(item.maintainer?.name === itLead.name && item.decisionOwner?.name === ops.name, `routed by the rules: ${item.maintainer?.name} / ${item.decisionOwner?.name}`);
  step('4. ответственный получил обращение: уведомление и назначение по правилам маршрутизации');
  await lead.call('POST', `/ideas/${n}/council/entries`, { kind: 'argument_for', body: 'Список занимает несколько минут и не требует закупок (учебный пример).' });
  await lead.call('POST', `/ideas/${n}/council/entries`, { kind: 'recommendation', recommendation: 'pilot', body: 'Проверить контрольный список на трёх сдачах и сравнить время подготовки.' });
  step('5. Совет обсудил вопрос: довод «за» и рекомендация провести пилот');

  // ---- 6. The decision owner decides — and only the decision owner ----
  const analystId = (await lead.call('GET', '/directory')).members.find((m) => m.name === analyst.name)?.membershipId;
  must(await lead.refused('POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale: 'Решаю за ответственного — так нельзя', implementer: analystId }), 'the lead cannot take the decision of the decision owner');
  const dec = await open(ops);
  await dec.call('POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale: 'Пилот на трёх сдачах: недорого и проверяемо (учебный пример).', implementer: analystId });
  step('6. решение принял уполномоченный сотрудник; ведущему в этом отказано');

  // ---- 7–8. The pilot is measured; the evidence is recorded ----
  const author = await open(engineer);
  must(await author.refused('POST', `/ideas/${n}/impact-verifications`, { plan: 'Замерю сам своё предложение', successCriteria: 'Быстрее, чем было', owner: analystId }), 'the author cannot measure his own proposal');
  await lead.call('POST', `/ideas/${n}/impact-verifications`, { plan: 'Три сдачи с контрольным списком; сравниваем время подготовки с тремя сдачами до него.', successCriteria: 'Подготовка к сдаче быстрее 80 минут', owner: analystId });
  item = await lead.call('GET', `/ideas/${n}`);
  const v = item.verifications.find((x) => x.purpose === 'impact' && x.status === 'running');
  must(v, 'the measurement runs');
  const m = await open(analyst);
  await m.call('POST', `/ideas/${n}/verifications/${v.id}/evidence`, { kind: 'baseline', body: 'Среднее по трём сдачам до контрольного списка (синтетические данные)', metric: METRIC, value: 96, unit: 'мин', period: 'три сдачи в октябре', source: 'журнал пусконаладки (учебный)', goal: 'decrease' });
  await m.call('POST', `/ideas/${n}/verifications/${v.id}/evidence`, { kind: 'result', body: 'Среднее по трём сдачам с контрольным списком (синтетические данные)', metric: METRIC, value: 72, unit: 'мин', period: 'три сдачи в ноябре, те же типы оборудования', source: 'журнал пусконаладки (учебный)', comparable: true });
  item = await m.call('GET', `/ideas/${n}`);
  must(item.verifications.find((x) => x.id === v.id).evidence.length === 2 && item.effect.measured, 'two measurements are kept and the effect is measured');
  step('7–8. пилот измерен; сохранены два доказательства: «до» 96 мин и «после» 72 мин');

  // ---- 9–10. The implementation and the effect are confirmed; the experience is granted once ----
  await m.call('POST', `/ideas/${n}/implementation`, { report: 'Контрольный список используется на всех сдачах (учебный пример).' });
  await lead.call('POST', `/ideas/${n}/verifications/${v.id}/conclusion`, { outcome: 'positive', conclusion: 'Подготовка к сдаче стала быстрее на четверть при тех же типах оборудования.' });
  must(await author.refused('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Подтверждаю эффект собственного предложения' }), 'the author cannot confirm his own effect');
  must(await lead.refused('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Время подготовки сократилось на четверть по журналу' }), 'the lead cannot confirm the effect');
  await dec.call('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Время подготовки сократилось на четверть, подтверждено журналом (учебный пример)' });
  must(await dec.refused('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Повторное подтверждение того же эффекта' }), 'the effect is confirmed once');
  item = await dec.call('GET', `/ideas/${n}`);
  must(item.status === 'implemented' && item.effect.approval, 'implemented and confirmed');
  step('9. внедрение и результат подтверждены; автору и ведущему в подтверждении отказано');

  const mine = await author.call('GET', '/me/envoy');
  const k2 = await author.call('GET', '/kingdom');
  const castleGain = k2.castles.reduce((sum, c) => sum + (c.xp - (xp0.castles[c.id] ?? c.xp)), 0);
  must(mine.xp > xp0.envoy, `the envoy's experience grew by the rules: ${xp0.envoy} → ${mine.xp}`);
  must(castleGain > 0, `the castle's experience grew: +${castleGain}`);
  // Looking at the card again grants nothing: the numbers come from the journal of confirmed events.
  must((await author.call('GET', '/me/envoy')).xp === mine.xp, 'reading does not add experience');
  const meId = (await author.call('GET', '/directory')).members.find((x) => x.name === engineer.name).membershipId;
  await author.hash(`#/people/${meId}`);
  await author.page.locator('.envoy-card').waitFor({ timeout: 15000 });
  await author.dismissScene();
  await author.shot('03-envoy-experience');
  step(`10. опыт начислен один раз: посол ${xp0.envoy} → ${mine.xp} XP (ранг ${mine.rank}), замок +${castleGain} XP; отдельные журналы`);

  // The engineer's notifications are real server events of this item; a scene, if shown, repeats one of them.
  const notes = await author.call('GET', '/notifications');
  const events = notes.filter((x) => x.ideaNumber === n).map((x) => x.event);
  must(events.includes('idea_merged') && events.includes('implemented'), `the author was told about the decision and the implementation: ${events}`);
  await author.ctx.close();

  // ---- 11. The solution reaches the Library: registered, checked by the archivist, opened to everyone ----
  const kid = (
    await lead.call('POST', '/knowledge', {
      kind: 'method',
      title: METHOD,
      card: {
        problem: 'При подготовке оборудования к сдаче повторялись одни и те же ошибки: забытые проверки, повторные выезды (учебный пример).',
        options: 'Оставить как есть; устная памятка; контрольный список подготовки к сдаче.',
        decision: 'Перед сдачей бригада проходит единый контрольный список и отмечает это в обращении.',
        reasons: 'Самый дешёвый способ убрать повторные ошибки; список легко поправить под новый тип оборудования.',
        results: 'На трёх сдачах время подготовки сократилось с 96 до 72 минут (синтетические данные учебного примера).',
        applicability: 'Сдача типового оборудования; для нестандартных объектов список нужно дополнить.',
      },
      sources: [{ type: 'idea', number: n }],
    })
  ).id;
  must(await lead.refused('POST', `/knowledge/${kid}/actions`, { action: 'library_accepted', reason: 'Принимаю собственную запись' }), 'the registrar does not accept their own entry');
  await lead.call('POST', `/knowledge/${kid}/actions`, { action: 'library_proposed', reason: 'Решение принято, результат измерен' });
  const keeper = await open(archivist);
  await keeper.call('POST', `/knowledge/${kid}/actions`, { action: 'library_accepted', reason: 'Источник и измерения проверены' });
  await dec.call('POST', `/knowledge/${kid}/actions`, { action: 'opened_to_organization', reason: 'Метод полезен всем подразделениям' });
  must((await keeper.call('GET', `/knowledge/${kid}`)).level === 'library', 'the knowledge is in the Library');
  step('11. решение передано в Библиотеку: зарегистрировано ведущим, проверено Архивариусом, открыто организации');
  await keeper.ctx.close();
  await lead.ctx.close();
  await m.ctx.close();

  // ---- 12. Another employee comes from the map and finds the method ----
  const b = await open(storekeeper, { view: '3d' });
  await b.hash('#/kingdom');
  await b.world();
  await b.dismissScene();
  const stood = await b.page.evaluate(() => {
    const w = window.__world;
    const lib = w.viewOf('library');
    w.setView({ x: lib.x + 26, z: lib.z + 40, dist: 500, az: lib.az + 0.45, pol: 1.0 });
    return w.getView();
  });
  const before = { envoy: (await b.call('GET', '/me/envoy')).xp, items: (await b.call('GET', '/kingdom')).envoys.filter((e) => e.mine).length };
  await b.page.locator('.w3d-plate[data-kind="library"]').click();
  await b.page.waitForFunction(() => location.hash.startsWith('#/library'), null, { timeout: 30000 });
  await b.page.locator('#lib-q').fill(`контрольный список ${RUN}`);
  // The search is debounced: wait for the answer of the server to this very query.
  await b.page.waitForFunction(() => /Найдено: \d+/.test(document.querySelector('.gc-result')?.textContent ?? ''), null, { timeout: 15000 });
  const found = b.page.locator('.gc-volumes a', { hasText: METHOD }).first();
  await found.waitFor({ timeout: 15000 });
  const result = await b.page.locator('.gc-result').innerText();
  const listed = await b.call('GET', `/knowledge?q=${encodeURIComponent(`контрольный список ${RUN}`)}`);
  must(result.includes(`Найдено: ${listed.total}`) && listed.items.some((i) => i.title === METHOD), `the catalogue states the server's exact number: ${result} / ${listed.total}`);
  must(/[?&]q=/.test(await b.page.evaluate(() => location.hash)), 'the query is kept in the address');
  await b.shot('04-method-found-in-the-library');
  step('12. другой сотрудник пришёл с карты и нашёл метод поиском по Библиотеке');

  // ---- The path of the solution: every node is a recorded fact of item №n ----
  await found.click();
  await b.page.locator('.sp').waitFor({ timeout: 15000 });
  const kinds = await b.page.locator('.sp-branch .sp-node').evaluateAll((els) => els.map((e) => e.dataset.type));
  must(['item', 'council', 'decision', 'verification', 'implementation', 'effect'].every((t) => kinds.includes(t)), `the path shows the item, the council, the decision, the check, the implementation and the result: ${kinds}`);
  const pathText = await b.page.locator('.sp').innerText();
  must(pathText.includes(`Обращение №${n}`) && pathText.includes('последняя рекомендация — провести пилот') && pathText.includes('сохранено: 2 доказательства') && pathText.includes('внедрено, результат подтверждён'), `the path repeats the recorded facts: ${pathText.slice(0, 400)}`);
  must(pathText.includes('Архивариус внёс в Библиотеку'), 'the trunk shows the Library');
  must((await b.page.locator(`.sp a[href="#/items/${n}"]`).count()) > 0, 'the nodes lead to the real record');
  const api = await b.call('GET', `/knowledge/${kid}`);
  must(api.path.branches.length === 1 && api.path.uses.length === 0 && api.applications.length === 0, 'one source, no applications yet');
  await b.shot('05-path-of-the-solution');
  step('«Путь решения»: обращение → Совет → решение → проверка → внедрение → результат → Библиотека, со ссылками на записи');

  // ---- 13–14. «Применить этот метод» → an ordinary new item with a reference to the knowledge ----
  await b.page.getByRole('link', { name: 'Применить этот метод' }).first().click();
  await b.page.waitForFunction(() => location.hash.startsWith('#/new?method='));
  await b.page.locator('.method-ref').waitFor({ timeout: 15000 });
  must((await b.page.locator('.method-ref').innerText()).includes(METHOD), 'the form names the method');
  await b.page.locator('#problem').fill('На складе при отгрузке оборудования повторяются те же пропуски проверок, что были при сдаче (учебный пример).');
  await b.page.locator('#proposal').fill('Применить контрольный список к отгрузке со склада и проверить на двух отгрузках (учебный пример).');
  await b.page.locator('#title').fill(`Контрольный список для отгрузки со склада (учебный пример ${RUN})`);
  await b.page.locator('#criteria').fill('Отгрузка без возвратов из-за пропущенных проверок');
  await b.shot('06-apply-the-method');
  await b.page.getByRole('button', { name: 'Создать обращение на основе метода' }).click();
  await b.page.waitForFunction(() => /#\/items\/\d+/.test(location.hash), null, { timeout: 15000 });
  const n2 = Number(/#\/items\/(\d+)/.exec(await b.page.evaluate(() => location.hash))[1]);
  await b.page.locator('.method-ref').waitFor({ timeout: 15000 });
  const item2 = await b.call('GET', `/ideas/${n2}`);
  must(item2.author.name === storekeeper.name && item2.method?.id === kid, 'the employee is the author of an ordinary item that refers to the knowledge');
  must(item2.status !== 'implemented' && !item2.effect.approval, 'nothing is implemented or confirmed by the click');
  const after = await b.call('GET', `/knowledge/${kid}`);
  must(after.applications.length === 0 && after.level === 'library', 'the method is not counted as applied and its level did not move');
  must(after.path.uses.length === 1 && after.path.uses[0].number === n2 && after.path.uses[0].status.label === 'Применение ещё не подтверждено', `the use is shown as not confirmed: ${JSON.stringify(after.path.uses)}`);
  must((await b.call('GET', '/me/envoy')).xp === before.envoy, 'no experience for pressing the button');
  await b.shot('07-item-started-from-the-method');
  step(`13–14. «Применить этот метод» → обращение №${n2} со ссылкой на знание; применение не подтверждено, XP не начислен`);

  // ---- 15. Back to the map: the camera is where the employee left it ----
  const way = b.page.locator('.world-return');
  await way.waitFor();
  must((await way.getAttribute('href')) === '#/kingdom', 'the way back leads to the city');
  await way.click();
  await b.world();
  const now = await b.page.evaluate(() => window.__world.getView());
  must(near(now, stood), `the camera is where it was left: ${JSON.stringify(stood)} → ${JSON.stringify(now)}`);
  must((await b.call('GET', '/kingdom')).envoys.filter((e) => e.mine).length === before.items + 1, 'and the new envoy of this employee is on the map');
  await b.shot('08-back-on-the-map');
  step('15. возврат на карту: камера там же, где сотрудник её оставил; его новый посол уже в пути');
  await b.ctx.close();
  await dec.ctx.close();

  // ---- A phone: the path and the catalogue without sideways scrolling ----
  const phone = await open(storekeeper, { viewport: { width: 390, height: 844 }, mobile: true });
  await phone.hash(`#/library/${kid}`);
  await phone.page.locator('.sp').waitFor({ timeout: 15000 });
  await phone.dismissScene();
  for (const where of [`#/library/${kid}`, '#/library', `#/new?method=${kid}`]) {
    await phone.hash(where);
    await phone.page.waitForTimeout(600);
    const over = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    must(over <= 1, `${where}: страница шире экрана на ${over} px`);
  }
  await phone.hash(`#/library/${kid}`);
  await phone.page.locator('.sp').scrollIntoViewIfNeeded();
  await phone.shot('09-phone-path');
  step('телефон 390×844: путь решения, каталог и форма применения метода без горизонтальной прокрутки');
  await phone.ctx.close();

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nСквозной сценарий «предложение инженера → метод для всей компании» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с через реальные API. Все данные сценария — учебные и синтетические.`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await gl.close();
}
