/**
 * The customer story of ADR-0031 through the real UI, desktop and phone:
 *   «Сокращение времени пусконаладки оборудования» — a FICTIONAL training example, not a real problem
 *   of any company; every number in it is synthetic and labelled so in the text.
 *
 *   an engineer files a problem and links it to a project, a stage of work and an affected department →
 *   the lead sees the context and whom one could invite → the Council recommends a pilot → the decision
 *   owner decides → the lead starts the measurement → the measurer records «before» and «after» →
 *   the implementation is confirmed → the effect is shown (and is «not measured» until the pair is
 *   comparable) → the decision owner approves it → the experience is offered to the Library.
 *
 *   npm run demo:refinement     (needs a freshly seeded demo server; SHOTS=dir saves screenshots)
 * Steps that existed before this work (council entry, decision, conclusion, approval) go through the
 * same API the UI uses; everything new is done on the screen.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { schematic } from './schematic.mjs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const engineer = by('Сервисный инженер');
const itLead = by('Руководитель ИТ-разработки');
const ops = by('Операционный директор');
const analyst = by('Системный аналитик');
const archivist = by('Архивариус');
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const browser = schematic(await chromium.launch());
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, message) => { if (!cond) throw new Error(message); };

async function open(person, viewport = { width: 1280, height: 860 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => { try { localStorage.setItem('modus.lite', '1'); localStorage.setItem('modus.howto.hidden', '1'); } catch {} });
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
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
      return text ? JSON.parse(text) : null;
    }, { method, path, body });
  const hash = async (h) => { await page.evaluate((x) => (location.hash = x), h); await page.waitForTimeout(200); };
  const shot = async (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);
  return { ctx, page, call, hash, shot };
}

const TITLE = 'Сокращение времени пусконаладки оборудования (учебный пример)';
const METRIC = 'Время подготовки к сдаче';

try {
  // ---- 1–3. The engineer files the problem; the optional block names the project, the stage and who else is touched ----
  let a = await open(engineer);
  await a.hash('#/new');
  await a.page.locator('#title').fill(TITLE);
  await a.page.locator('#problem').fill('При подготовке оборудования к сдаче повторяются одни и те же ошибки: забытые проверки, повторные выезды. Пример учебный, данные вымышлены.');
  const proposal = a.page.locator('#proposal');
  if (await proposal.count()) await proposal.fill('Ввести электронный контрольный список подготовки к сдаче и проверить его на трёх объектах.');
  await a.page.locator('#category').selectOption({ label: 'ИТ и инструменты' });
  const block = a.page.locator('details.ctx-disclosure');
  must(!(await block.getAttribute('open')), 'the context block is closed by default: an ordinary idea needs no extra fields');
  await block.locator('summary').click();
  await a.page.locator('#new-ctx-project').fill('Объект «Северный» (учебный пример)');
  await a.page.locator('#new-ctx-stage').selectOption({ label: 'Пусконаладка' });
  await a.page.locator('.ctx-chips label', { hasText: 'Пусконаладка' }).click();
  await a.shot('01-new-item-context');
  await a.page.getByRole('button', { name: /^Отправить/ }).click();
  await a.page.waitForFunction(() => /#\/items\/\d+/.test(location.hash), null, { timeout: 15000 });
  const n = Number(/#\/items\/(\d+)/.exec(await a.page.evaluate(() => location.hash))[1]);
  must(n > 0, 'the item is filed');
  const panel = a.page.locator('.ctx-panel');
  await panel.waitFor();
  const facts = await panel.innerText();
  must(facts.includes('Объект «Северный» (учебный пример)') && facts.includes('Пусконаладка') && facts.includes(engineer.name), `the card shows the project, the stage and who named them: ${facts}`);
  must((await panel.locator('.ctx-affected-list li').count()) === 1, 'one affected department is listed');
  must((await a.page.getByText('Эффект пока не измерен').count()) === 0, 'no effect block before anything is decided or measured');
  let item = await a.call('GET', `/ideas/${n}`);
  must(item.maintainer?.name === itLead.name && item.decisionOwner?.name === ops.name, `routed by the topic to its lead and decision owner: ${item.maintainer?.name} / ${item.decisionOwner?.name}`);
  must(item.department !== 'Пусконаладка', 'the affected department is not the responsible one');
  step(`инженер подал обращение №${n} и связал его с проектом, этапом «Пусконаладка» и затронутым подразделением`);
  await a.ctx.close();

  // ---- 4–5. The lead sees the context and a suggestion of whom to invite; the Council recommends a pilot ----
  let lead = await open(itLead);
  await lead.hash(`#/items/${n}`);
  const who = lead.page.locator('.ctx-who');
  await who.waitFor();
  must((await who.innerText()).includes('Нурлан Абенов') && (await who.innerText()).includes('без ИИ'), 'the head of the affected department is suggested, by rules and labelled so');
  await lead.hash(`#/council/${n}`);
  await lead.page.locator('.council-panel .ctx-panel .ctx-who').waitFor();
  must((await lead.page.locator('.council-panel .ctx-panel').innerText()).includes('Обсуждение — не разрешение на внедрение'), 'the Council shows the context and says that a discussion is not a decision');
  await lead.shot('02-council-context');
  await lead.call('POST', `/ideas/${n}/council/entries`, { kind: 'recommendation', recommendation: 'pilot', body: 'Проверить контрольный список на трёх сдачах и сравнить время подготовки.' });
  step('ведущий видит контекст и подсказку, кого пригласить; Совет рекомендует пилот');
  await lead.ctx.close();

  // ---- 6. The decision owner decides; nobody else can ----
  const dec = await open(ops);
  const analystId = (await dec.call('GET', '/directory')).members.find((m) => m.name === analyst.name)?.membershipId;
  must(analystId, 'the measurer is in the directory');
  await dec.call('POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale: 'Пилот на трёх сдачах: недорого и проверяемо.', implementer: analystId });
  await dec.ctx.close();
  const author = await open(engineer);
  let denied = false;
  try { await author.call('POST', `/ideas/${n}/impact-verifications`, { plan: 'Замерю сам своё предложение', successCriteria: 'Быстрее, чем было', owner: analystId }); } catch { denied = true; }
  must(denied, 'the author cannot start the measurement of their own proposal');
  await author.ctx.close();
  step('решение о пилоте принял ответственный за решение; автор не может сам запустить измерение');

  // ---- 7. The lead starts the measurement on the screen ----
  lead = await open(itLead);
  await lead.hash(`#/items/${n}`);
  await lead.page.getByRole('button', { name: 'Измерить эффект внедрения' }).click();
  await lead.page.locator('#ck-plan').fill('Три сдачи с контрольным списком; сравниваем время подготовки к сдаче с тремя сдачами до него.');
  await lead.page.locator('#ck-crit').fill('Подготовка к сдаче быстрее 80 минут');
  await lead.page.locator('#ck-owner').selectOption({ label: (await lead.page.locator('#ck-owner option', { hasText: analyst.name }).first().innerText()) });
  await lead.page.getByRole('button', { name: 'Начать измерение' }).click();
  await lead.page.getByText('Измерение эффекта начато').waitFor();
  item = await lead.call('GET', `/ideas/${n}`);
  const v = item.verifications.find((x) => x.purpose === 'impact' && x.status === 'running');
  must(v && item.stage === 'adoption', 'the measurement runs and the stage did not change');
  step('ведущий запустил измерение эффекта: статус обращения не изменился');
  await lead.ctx.close();

  // ---- 8. The measurer records «before» and «after» on the screen ----
  const m = await open(analyst);
  await m.hash(`#/items/${n}`);
  const record = async (kind, value, period, extra) => {
    await m.page.getByRole('button', { name: 'Добавить результат' }).first().click();
    await m.page.locator('#ev-kind').selectOption(kind);
    await m.page.locator('#ev-body').fill(kind === 'baseline' ? 'Среднее по трём сдачам до контрольного списка (синтетические данные)' : 'Среднее по трём сдачам с контрольным списком (синтетические данные)');
    await m.page.locator('#ev-metric').fill(METRIC);
    await m.page.locator('#ev-value').fill(String(value));
    await m.page.locator('#ev-unit').fill('мин');
    await m.page.locator('#ev-period').fill(period);
    await m.page.locator('#ev-source').fill('журнал пусконаладки (учебный)');
    await extra();
    await m.page.getByRole('button', { name: 'Записать', exact: true }).click();
    await m.page.getByText('Результат записан').first().waitFor();
    await m.page.waitForTimeout(300);
  };
  await record('baseline', 96, 'три сдачи в октябре', () => m.page.locator('#ev-goal').selectOption('decrease'));
  await m.page.locator('.effect-panel').waitFor();
  let effect = await m.page.locator('.effect-panel').innerText();
  must(effect.includes('Эффект пока не измерен') && effect.includes('нет измерения «после»') && !/%/.test(effect), `only a «before»: not measured, no percent: ${effect}`);
  // An «after» that is not stated as comparable gives no number.
  await record('result', 60, 'одна сдача на другом объекте', async () => undefined);
  effect = await m.page.locator('.effect-panel').innerText();
  must(effect.includes('Эффект пока не измерен') && effect.includes('Несопоставимо') && !/−\d/.test(effect), `an incomparable «after» gives no difference: ${effect}`);
  await m.shot('03-effect-not-measured');
  await record('result', 72, 'три сдачи в ноябре, те же типы оборудования', () => m.page.locator('.check-line input').check());
  effect = await m.page.locator('.effect-panel').innerText();
  must(!effect.includes('Эффект пока не измерен') && effect.includes('96 мин') && effect.includes('72 мин') && effect.includes('−24 мин') && effect.includes('−25%') && effect.includes('Улучшение'), `the comparable pair is measured: ${effect}`);
  must(effect.includes('три сдачи в октябре') && effect.includes('журнал пусконаладки') && effect.includes(analyst.name), 'the origin of each number is shown: period, source, who recorded it');
  await m.shot('04-effect-measured');
  // The implementation is confirmed by its implementer.
  await m.call('POST', `/ideas/${n}/implementation`, { report: 'Контрольный список используется на всех сдачах (учебный пример).' });
  step('исполнитель записал «до» и «после»: без пары — «эффект пока не измерен», несопоставимое не считается, сопоставимая пара — −24 мин (−25%)');
  await m.ctx.close();

  // ---- 9. The lead concludes the measurement; the decision owner approves the effect; nobody else can ----
  lead = await open(itLead);
  await lead.call('POST', `/ideas/${n}/verifications/${v.id}/conclusion`, { outcome: 'positive', conclusion: 'Подготовка к сдаче стала быстрее на четверть при тех же типах оборудования.' });
  let leadDenied = false;
  try { await lead.call('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Время подготовки сократилось на четверть по журналу' }); } catch { leadDenied = true; }
  must(leadDenied, 'the lead cannot approve the effect: it belongs to the decision owner');
  await lead.ctx.close();
  const owner = await open(ops);
  await owner.call('POST', `/ideas/${n}/effect`, { xp: 20, rationale: 'Время подготовки сократилось на четверть, подтверждено журналом (учебный пример)' });
  await owner.hash(`#/items/${n}`);
  await owner.page.locator('.effect-panel').waitFor();
  must((await owner.page.locator('.effect-panel').innerText()).includes(`подтвердил(а) ${ops.name}`), 'the approval is shown next to the measurement, with the name');
  item = await owner.call('GET', `/ideas/${n}`);
  must(item.status === 'implemented' && item.effect.measured && item.effect.approval, 'implemented, measured and approved');
  step('измерение завершено; эффект подтвердил ответственный за решение (ведущему отказано)');
  await owner.ctx.close();

  // ---- 10. The experience is offered to the Library; nothing is accepted automatically ----
  const keeper = await open(archivist);
  await keeper.hash(`#/items/${n}`);
  const offer = keeper.page.locator('.library-offer');
  await offer.waitFor();
  must((await offer.innerText()).includes('Сохранить полученный опыт в Библиотеку знаний'), 'the offer is shown after the confirmed implementation');
  await offer.getByRole('link', { name: 'Внести в Летопись' }).click();
  await keeper.page.waitForFunction(() => location.hash.startsWith('#/library/new'));
  await keeper.page.waitForFunction((metric) => [...document.querySelectorAll('textarea, input')].some((el) => el.value.includes(`${metric}: было 96 мин, стало 72 мин`)), METRIC, { timeout: 15000 });
  const fields = await keeper.page.locator('textarea, input').evaluateAll((els) => els.map((e) => e.value).join('\n'));
  must(!fields.includes('60'), 'the incomparable number is not carried into the draft');
  const known = await keeper.call('GET', '/knowledge');
  must(!JSON.stringify(known).includes(TITLE), 'nothing is saved or accepted until a person does it');
  await keeper.shot('05-library-draft');
  step('Архивариусу предложено сохранить опыт: черновик с измеренной строкой, без автоматического принятия');
  await keeper.ctx.close();

  // ---- Phone: the same form and card ----
  const phone = await open(engineer, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await phone.hash('#/new');
  const summary = phone.page.locator('details.ctx-disclosure summary');
  await summary.scrollIntoViewIfNeeded();
  await summary.tap();
  for (const el of [summary, phone.page.locator('#new-ctx-project'), phone.page.locator('#new-ctx-stage'), phone.page.locator('.ctx-chips label').first()]) {
    const r = await el.boundingBox();
    must(r && r.height >= 40, `touch target too small on the phone: ${JSON.stringify(r)}`);
  }
  await phone.hash(`#/items/${n}`);
  await phone.page.locator('.effect-panel').waitFor();
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  must(overflow <= 1, `the item card does not scroll sideways on the phone (overflow ${overflow}px)`);
  must((await phone.page.locator('.effect-panel').innerText()).includes('−25%'), 'the measured effect is readable on the phone');
  await phone.shot('06-phone-item');
  step('телефон 390×844: блок «Связать с проектом» и карточка с измеренным эффектом без горизонтальной прокрутки');
  await phone.ctx.close();

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nСценарий «от инициативы к измеримому результату» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с. Данные сценария — учебные и синтетические.`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
