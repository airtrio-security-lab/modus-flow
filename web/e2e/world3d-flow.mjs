/**
 * «3D-город» through the real UI (owner brief 2026-11-11, ADR-0026): the WebGL scene is built from the
 * real `/kingdom` response; the camera moves, zooms and turns; a click on the BUILDING itself (not only
 * on its label) opens the department; the citadel shows the castle in 3D with a labelled preview of the
 * next levels; search finds departments, colleagues, items and rows of the organizer's set; without
 * WebGL the schematic city is shown; the phone layout uses a bottom sheet and a bottom tab bar.
 *
 * Needs a freshly seeded demo database WITH the organizer's set imported:
 *   npm run demo:seed && npm run platform:import-dataset -- --demo-confirm A-004,A-008 && npm run demo:world3d
 *
 * WebGL here is SwiftShader (software): frame times printed at the end are NOT those of a real GPU or phone.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const whHead = by('Начальник склада');
const ops = by('Операционный директор');
const SHOTS = process.env.SHOTS;
const CIV = { camelot: 'Камелот', japan: 'Японский сёгунат', kazakh: 'Казахское ханство', mongolia: 'Монгольская держава', russia: 'Русское царство' };

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const t0 = Date.now();
const DESK = { viewport: { width: 1180, height: 720 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function as(person, fn, opts = DESK, init) {
  const ctx = await browser.newContext(opts);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.setItem('modus.lite', '0');
    localStorage.setItem('modus.w3d.hint', '1');
    // Software WebGL: the lowest tier keeps the page responsive; the picture itself is reviewed on screenshots.
    localStorage.setItem('modus.w3d.quality', 'low');
  });
  await page.reload();
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}
// Evaluated as an expression through the debugger protocol, so the page's script policy is not relaxed for it.
const world = (page, fn, arg) => page.evaluate(`(${fn.toString()})(window.__world, ${JSON.stringify(arg ?? null)})`);
async function openCity(page) {
  await page.goto(`${BASE}/#/kingdom`);
  await page.locator('.w3d').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
  // Software rendering: draw on demand so the page stays responsive to the test's input.
  await world(page, (w) => { w.live = false; w.renderNow(); });
}
const api = (page, path) =>
  page.evaluate(async (path) => (await fetch(`/api/v1/orgs/modus-demo${path}`, { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } })).json(), path);
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};
let perf = null;

try {
  // 1. The scene is the real data: every department is a district of its civilization and server level.
  await as(storekeeper, async (page) => {
    await openCity(page);
    const k = await api(page, '/kingdom');
    const stats = await world(page, (w) => w.stats());
    must(stats.districts === k.castles.length, `districts ${stats.districts} ≠ castles ${k.castles.length}`);
    must(stats.envoys === k.envoys.length, `envoys in the scene ${stats.envoys} ≠ open items ${k.envoys.length}`);
    must(stats.triangles > 100000 && stats.calls > 20, `the scene is not a real 3D world: ${JSON.stringify(stats)}`);
    must((await page.locator('button.w3d-plate').count()) === k.castles.length, 'one label per department');
    for (const c of k.castles) await page.locator(`button.w3d-plate[aria-label*="${c.name}, уровень ${c.level}"]`).waitFor({ state: 'attached' });
    const shown = await page.locator('.w3d-stats dd').first().innerText();
    must(Number(shown) === k.envoys.length, 'the HUD counts the same open items');
    // The canvas really has a picture: not one flat colour.
    const colours = await page.evaluate(() => {
      const c = document.querySelector('.w3d-canvas');
      const t = document.createElement('canvas');
      t.width = 64;
      t.height = 36;
      const g = t.getContext('2d');
      window.__world.renderNow();
      g.drawImage(c, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
      return set.size;
    });
    must(colours > 40, `the canvas looks empty (${colours} colours)`);
    await shot(page, '01-city');
    step(`3D-город построен из данных сервера: ${k.castles.length} районов, ${k.envoys.length} гонцов, ${stats.triangles} треугольников, ${stats.calls} вызовов отрисовки`);

    // 2. Camera: zoom, turn, move, and the limits.
    const v0 = await world(page, (w) => w.getView());
    await page.locator('.w3d').focus();
    await page.keyboard.press('+');
    await page.getByRole('button', { name: 'Повернуть вправо' }).click();
    await page.locator('.w3d').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(900);
    const v1 = await world(page, (w) => w.getView());
    must(v1.dist < v0.dist * 0.9, 'zoom in works');
    must(Math.abs(v1.az - v0.az) > 0.2, 'rotation works');
    must(Math.hypot(v1.x - v0.x, v1.z - v0.z) > 20, 'panning works');
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(700);
    must((await world(page, (w) => w.getView())).dist < v1.dist, 'the wheel zooms');
    await world(page, (w) => { for (let i = 0; i < 30; i++) w.nudge('out'); });
    await page.waitForTimeout(900);
    const far = await world(page, (w) => w.getView());
    await world(page, (w) => { for (let i = 0; i < 40; i++) w.nudge('in'); });
    await page.waitForTimeout(1200);
    const near = await world(page, (w) => w.getView());
    must(far.dist < 5000 && near.dist >= 46, `camera limits hold: ${far.dist} … ${near.dist}`);
    await page.getByRole('button', { name: 'Весь город' }).click();
    await page.waitForFunction(() => !window.__world.flying, null, { timeout: 15000 });
    step('камера: приближение, поворот, перемещение, колесо, пределы, возврат к обзору');

    // 3. A click on the building itself opens the department card; the flight can be skipped.
    // The building must be clicked where nothing but the canvas is under the pointer.
    let target = null;
    let at = null;
    for (const c of k.castles) {
      const p = await world(page, (w, id) => w.screenOf(id), c.id);
      const free = p && (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('w3d-canvas') ?? false, p));
      if (free) {
        target = c;
        at = p;
        break;
      }
    }
    must(target, 'no district is free of labels and panels in the overview');
    await page.mouse.click(at.x, at.y);
    await page.locator('.w3d-district').waitFor();
    must((await page.locator('.w3d-district header b').innerText()) === target.name, `the clicked building is «${target.name}»`);
    // The flight starts with the click and can be skipped; checked inside the page, where software rendering cannot outrun it.
    const other = k.castles.find((c) => c.id !== target.id);
    const flight = await page.evaluate(async (name) => {
      const w = window.__world;
      await w.flyTo(w.overview(), 0);
      [...document.querySelectorAll('button.w3d-plate')].find((b) => b.getAttribute('aria-label').includes(name)).click();
      const started = w.flying;
      for (let i = 0; i < 40 && !document.querySelector('.w3d-skip'); i++) await new Promise((r) => setTimeout(r, 25));
      const button = document.querySelector('.w3d-skip');
      button?.click();
      return { started, button: Boolean(button), after: w.flying };
    }, `${other.name}, уровень`);
    must(flight.started && flight.button && !flight.after, `the flight starts and is skipped at once: ${JSON.stringify(flight)}`);
    await page.locator(`button.w3d-plate[aria-label*="${target.name}, уровень"]`).dispatchEvent('click');
    await page.waitForFunction(() => !window.__world.flying, null, { timeout: 20000 });
    await page.locator('.w3d-district header b', { hasText: target.name }).waitFor();
    const sheet = await page.locator('.w3d-district').innerText();
    must(sheet.includes(`Уровень ${target.level} · ${target.levelName}`) && sheet.includes(CIV[target.civilization]), 'the card shows the server level and the civilization');
    must(sheet.includes(String(target.xp)), 'the card shows real XP');
    await shot(page, '02-district-card');
    step('клик по самому зданию открывает карточку подразделения; перелёт пропускается');

    // 4. Into the citadel: the same department screen, the castle in 3D, a labelled preview of the next levels.
    await page.getByRole('button', { name: 'Войти в цитадель' }).click();
    await page.locator('.district-tabs').waitFor({ timeout: 20000 });
    must(page.url().endsWith(`#/castles/${target.id}`), 'the citadel is the department screen');
    // Camelot and the Russian Tsardom open on their painted town; the citadel and the header are on every other tab.
    if (!(await page.locator('.district-head').count())) await page.goto(`${BASE}/#/castles/${target.id}/staff`);
    await page.locator('.district-head').waitFor({ timeout: 20000 });
    await page.locator('.citadel3d-levels').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.citadel3d-wait'), null, { timeout: 90000 });
    must((await page.locator('.citadel3d-cap').innerText()).includes(`уровень ${target.level}`), 'the citadel shows the real level');
    await page.locator('.citadel3d-levels button', { hasText: '5' }).click();
    const cap = await page.locator('.citadel3d-cap').innerText();
    must(/Предпросмотр уровня 5/.test(cap) && cap.includes(`Сейчас у отдела уровень ${target.level}`), 'a higher level is shown only as a labelled preview');
    must((await page.locator('.district-head').innerText()).includes(`Уровень ${target.level}`), 'the real level did not change');
    await shot(page, '03-citadel');
    await page.locator('.staff-card').first().waitFor();
    step('цитадель: тот же экран отдела, замок в 3D, предпросмотр уровней подписан и ничего не меняет');

    // 5. Back to the city: the camera is where it was left.
    await page.getByRole('link', { name: '← Город' }).click();
    await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
    const back = await world(page, (w) => w.getView());
    const site = await world(page, (w, id) => w.viewOf(id), target.id);
    must(Math.hypot(back.x - site.x, back.z - site.z) < 30 && back.dist < 400, 'the camera returned to the district');
    step('возврат в город сохраняет положение камеры');
  });

  // 6. Search and the neutral centre.
  await as(whHead, async (page) => {
    await openCity(page);
    const box = page.getByRole('searchbox');
    await box.fill('склад');
    await page.locator('.w3d-results button', { hasText: 'Склад и логистика' }).click();
    await page.locator('.w3d-district').waitFor();
    await box.fill('Асель');
    await page.locator('.w3d-results button', { hasText: 'Асель Темирова' }).waitFor();
    await box.fill('A-007');
    await page.locator('.w3d-results button', { hasText: 'Набор организатора · A-007' }).click();
    await page.locator('.dataset-note').waitFor({ timeout: 20000 });
    const note = await page.locator('.dataset-note').innerText();
    must(note.includes('A-007') && note.includes('Интеграции и IT') && note.includes('Высокий') && note.includes('Новое'), 'the item keeps the row\'s id, category, priority and conditional status');
    step('поиск: подразделение, коллега, строка набора A-007 → карточка обращения с исходными полями');

    await page.goto(`${BASE}/#/dataset`);
    await page.locator('table.dataset-table tbody tr').first().waitFor();
    must((await page.locator('table.dataset-table tbody tr').count()) === 20, '20 rows of the set');
    const confirmed = await page.locator('table.dataset-table tbody tr', { hasText: 'демо-подтверждение' }).count();
    must(confirmed === 2, `only the two explicit demo confirmations carry XP (${confirmed})`);
    const a17 = await page.locator('table.dataset-table tbody tr', { hasText: 'A-017' }).innerText();
    must(a17.includes('Отклонено'), 'A-017 is rejected with its reason');
    step('набор организатора: 20 строк, исходные статусы, XP только у двух подписанных демо-подтверждений');

    await openCity(page);
    await page.locator('a.w3d-plate[data-kind="palace"]').dispatchEvent('click');
    await page.waitForFunction(() => location.hash === '#/council', null, { timeout: 20000 });
    step('дворец Большого Круглого стола: перелёт и переход в Совет');

    await openCity(page);
    await page.getByRole('button', { name: 'Схема', exact: true }).click();
    await page.locator('.realm-map svg').waitFor();
    await page.getByRole('button', { name: '3D-город' }).click();
    await page.locator('.w3d').waitFor();
    await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
    await world(page, (w) => { w.live = true; });
    await page.waitForTimeout(6000);
    perf = await world(page, (w) => w.stats());
    step('переключение 3D ↔ схема');
  });

  // 6a. Cards over the envoys' heads, the envoy's card, «Оценка ИИ» without a model, postponing by the person who decides.
  let paused = null;
  await as(ops, async (page) => {
    await openCity(page);
    const k = await api(page, '/kingdom');
    must((await page.locator('button.w3d-envoy').count()) === k.envoys.length, 'every envoy has a card');
    // An item this person decides and did not raise: only there «Отложить решение» is offered.
    for (const e of k.envoys) {
      const it = await api(page, `/ideas/${e.number}`);
      if (it.decisionOwner?.name === ops.name && it.author.name !== ops.name && ['published', 'review', 'decision'].includes(it.stage) && !it.deferral && e.departmentId) {
        paused = { number: e.number, author: it.author.name, departmentId: e.departmentId, due: it.resolutionDueAt };
        break;
      }
    }
    must(paused, 'the demo has an open item decided by the operations director');
    const chip = page.locator(`button.w3d-envoy[aria-label^="Обращение №${paused.number} от ${paused.author}"]`);
    must((await chip.locator('.w3d-envoy-head').textContent()).includes(`№${paused.number}`), 'the card names the item and the sender');
    await chip.dispatchEvent('click');
    await page.waitForFunction(() => !window.__world.flying, null, { timeout: 20000 });
    await world(page, (w) => w.renderNow());
    const shown = await page.evaluate((n) => ({
      all: [...document.querySelectorAll('button.w3d-envoy')].filter((b) => b.style.visibility === 'visible').length,
      mine: document.querySelector(`button.w3d-envoy[aria-label^="Обращение №${n} "]`).style.visibility,
    }), paused.number);
    must(shown.all > 0 && shown.mine === 'visible', `the camera came to the envoy and its card is over its head: ${JSON.stringify(shown)}`);
    await page.locator('.w3d-item .track').waitFor({ timeout: 20000 });
    const card = await page.locator('.w3d-item').innerText();
    must(card.includes('От кого') && card.includes(paused.author) && card.includes('Кто отвечает') && card.includes('Открыть обращение'), 'the envoy card says who it is from, who answers, and opens the item');
    must((await page.locator('.w3d-item .track li').count()) === 4, 'the route is four plain steps');
    await page.locator('.w3d-item').getByRole('button', { name: 'Оценка ИИ' }).click();
    await page.locator('.w3d-item .quick-note[data-kind="off"]').waitFor();
    must((await page.locator('.w3d-item .quick-note[data-kind="off"]').innerText()).includes('ИИ не подключён'), 'without a model the AI assessment says so');
    must((await page.locator('.w3d-item .ai-result').count()) === 0, 'and shows no made-up assessment');
    await shot(page, '05-envoy-card');
    step('карточки над гонцами; карточка обращения: от кого, кто отвечает, четыре шага; «Оценка ИИ» честно пишет «не подключён»');

    await page.locator('.w3d-item').getByRole('button', { name: 'Отложить решение' }).click();
    await page.locator('.w3d-item textarea').fill('Ждём поставку терминалов, вернёмся после приёмки');
    await page.locator('.w3d-item').getByRole('button', { name: /^Отложить до / }).click();
    await page.locator('.w3d-item .quick-note[data-kind="paused"]').waitFor({ timeout: 20000 });
    const after = await api(page, `/ideas/${paused.number}`);
    must(after.deferral && new Date(after.resolutionDueAt) - new Date(paused.due) > 7 * 86400000, 'the decision is postponed and the deadline is paused');
    must(after.stage && after.status !== 'closed', 'the item itself is untouched');
    await page.waitForFunction((n) => document.querySelector(`button.w3d-envoy[aria-label^="Обращение №${n} "]`)?.dataset.tone === 'paused', paused.number, { timeout: 20000 });
    await shot(page, '06-postponed');
    step('ответственный за решение откладывает: дата, причина, срок на паузе, гонец помечен');
  });
  await as(storekeeper, async (page) => {
    await openCity(page);
    await page.locator(`button.w3d-envoy[aria-label^="Обращение №${paused.number} "]`).dispatchEvent('click');
    await page.locator('.w3d-item .quick-note[data-kind="paused"]').waitFor({ timeout: 20000 });
    const text = await page.locator('.w3d-item').innerText();
    must(text.includes('Решение отложено до') && text.includes('Ждём поставку терминалов'), 'everyone reads the date and the reason');
    must((await page.locator('.w3d-item').getByRole('button', { name: /Вернуть в работу|Отложить решение/ }).count()) === 0, 'who does not decide gets no postpone buttons');
    step('остальные видят «отложено до …» и причину, но кнопок отложить и вернуть у них нет');
  });
  await as(ops, async (page) => {
    await page.goto(`${BASE}/#/items/${paused.number}`);
    await page.getByRole('button', { name: 'Вернуть в работу сейчас' }).click();
    await page.getByRole('button', { name: 'Отложить решение' }).waitFor({ timeout: 20000 });
    const back = await api(page, `/ideas/${paused.number}`);
    must(!back.deferral && Math.abs(new Date(back.resolutionDueAt) - new Date(paused.due)) < 120000, 'returned to work: the deadline is back where it was');
    step('на странице обращения: «Вернуть в работу» возвращает срок на место');
  });

  // 7. No WebGL: the schematic city with an explanation; reduced motion: the schematic city by default.
  await as(
    storekeeper,
    async (page) => {
      await page.goto(`${BASE}/#/kingdom`);
      await page.locator('.realm-map svg').waitFor({ timeout: 30000 });
      await page.getByText('нет WebGL', { exact: false }).waitFor();
      must((await page.locator('.w3d').count()) === 0, 'no 3D stage without WebGL');
      step('без WebGL показана схема города и объяснение');
    },
    DESK,
    () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : real.call(this, type, ...rest);
      };
    },
  );
  await as(
    storekeeper,
    async (page) => {
      await page.goto(`${BASE}/#/kingdom`);
      await page.locator('.realm-map svg').waitFor({ timeout: 30000 });
      must((await page.locator('.w3d').count()) === 0, 'reduced motion opens the schematic city');
      step('при «уменьшить движение» по умолчанию открывается схема');
    },
    { ...DESK, reducedMotion: 'reduce' },
  );

  // 7a. A choice of «the map» saved before the 3D city existed does not hide the 3D city; «the table» stays.
  await as(storekeeper, async (page) => {
    await page.evaluate(() => localStorage.setItem('modus.kingdom.mode', 'city'));
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.w3d').waitFor({ timeout: 60000 });
    await page.evaluate(() => localStorage.setItem('modus.kingdom.mode', 'work'));
    await page.reload();
    await page.locator('table.work-table').waitFor({ timeout: 30000 });
    step('старый сохранённый выбор «карта» не скрывает 3D; выбор «таблица» сохранён');
  });

  // 7b. The town of a district in 3D (ADR-0029): the Russian Tsardom of the demo, eight buildings, each a plain link.
  await as(storekeeper, async (page) => {
    const k = await page.evaluate(async () => (await fetch('/api/v1/orgs/modus-demo/kingdom', { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } })).json());
    const rus = k.castles.find((c) => c.name === 'Закупки');
    must(rus, 'the demo has the purchasing district');
    await page.goto(`${BASE}/#/castles/${rus.id}/city`);
    // The painted panorama is the default; 3D is the second view of the same town and is remembered.
    await page.locator('.town-canvas img').waitFor({ timeout: 30000 });
    must((await page.locator('.town-hotspot').count()) === 8, 'the painted Russian town has eight buildings');
    await page.getByRole('group', { name: 'Вид города' }).getByRole('button', { name: '3D' }).click();
    await page.locator('.town3d-pin').first().waitFor({ state: 'attached', timeout: 90000 });
    must((await page.locator('.citadel3d').getAttribute('aria-label')).includes('Город отдела «Закупки» в 3D'), 'the 3D town is named');
    must((await page.locator('.town3d-pin').count()) === 8, 'eight pins stand over the 3D town');
    await page.waitForFunction(() => [...document.querySelectorAll('.town3d-pin')].filter((e) => e.style.visibility === 'visible').length >= 6, null, { timeout: 60000 });
    const names = await page.locator('.town3d-list a strong').allInnerTexts();
    must(['Московский Кремль', 'Боярская дума', 'Торговая площадь', 'Воинская палата'].every((n) => names.includes(n)), `the list names the Russian buildings: ${names.join(', ')}`);
    must((await page.locator('.citadel3d-cap').innerText()).includes('Русское царство'), 'the caption names the civilization');
    // A higher level is a labelled preview: the real level does not change.
    await page.getByRole('button', { name: /Уровень 5/ }).click();
    await page.getByText('Предпросмотр уровня 5').waitFor();
    await page.waitForTimeout(1500);
    await shot(page, '08-town3d-russia');
    must((await page.evaluate(() => localStorage.getItem('modus.town.view'))) === '3d', 'the choice of 3D is remembered');
    // A pin and a list entry are the same ordinary link.
    const pin = page.locator('.town3d-pin', { hasText: 'Боярская дума' });
    must((await pin.getAttribute('href')) === `#/castles/${rus.id}/council`, 'the pin of the Duma leads to the council of the district');
    await page.getByRole('navigation', { name: 'Все здания города «Закупки»' }).getByRole('link', { name: /Торговая площадь/ }).click();
    await page.waitForFunction((id) => location.hash === `#/castles/${id}/initiatives`, rus.id, { timeout: 20000 });
    step('город отдела в 3D: Русское царство, восемь зданий-ссылок, предпросмотр уровня подписан, выбор вида запоминается');
    // A civilization without a painted panorama gets the 3D town straight away, with the hall named by the server.
    const it = k.castles.find((c) => c.name === 'ИТ-разработка');
    await page.goto(`${BASE}/#/castles/${it.id}/city`);
    await page.locator('.town3d-pin').first().waitFor({ state: 'attached', timeout: 90000 });
    must((await page.getByRole('group', { name: 'Вид города' }).count()) === 0, 'no panorama switch where no panorama is painted');
    must((await page.locator('.town3d-list a strong').allInnerTexts()).includes('Зал даймё'), 'the council hall of the Japanese district keeps its name');
    await page.evaluate(() => localStorage.removeItem('modus.town.view'));
    step('город без нарисованной панорамы открывается сразу в 3D');
  });
  // 7c. Without WebGL the town is the list of its buildings, and it says so.
  await as(
    storekeeper,
    async (page) => {
      const k = await page.evaluate(async () => (await fetch('/api/v1/orgs/modus-demo/kingdom', { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } })).json());
      const it = k.castles.find((c) => c.name === 'ИТ-разработка');
      await page.goto(`${BASE}/#/castles/${it.id}/city`);
      await page.getByText('3D здесь недоступно').waitFor({ timeout: 30000 });
      must((await page.locator('.town3d-list a').count()) === 8 && (await page.locator('.town3d-pin').count()) === 0, 'the list of eight buildings replaces the 3D town');
      step('без WebGL город отдела — список зданий с объяснением');
    },
    DESK,
    () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : real.call(this, type, ...rest);
      };
    },
  );

  // 8. Phone: the same world, a bottom tab bar, a bottom sheet, the list as an alternative to the map.
  await as(
    whHead,
    async (page) => {
      await openCity(page);
      const k = await api(page, '/kingdom');
      const nav = await page.locator('.w3d-top nav').boundingBox();
      must(nav.y > 700, 'sections are a bottom tab bar on a phone');
      await page.getByRole('button', { name: 'Список подразделений' }).tap();
      must((await page.locator('.w3d-sheet li').count()) === k.castles.length, 'the list names every department');
      await page.locator('.w3d-sheet li button', { hasText: 'ИТ-разработка' }).tap();
      await page.locator('.w3d-district').waitFor();
      const sheet = await page.locator('.w3d-district').boundingBox();
      must(sheet.y > 844 * 0.38 && sheet.width >= 388, 'the department card is a bottom sheet');
      must((await page.locator('.w3d-district').innerText()).includes('Японский сёгунат'), 'the IT district is the Japanese shogunate');
      for (const b of await page.locator('.w3d-controls button, .w3d-district .w3d-cta, .w3d-top nav a').all()) {
        const r = await b.boundingBox();
        must(!r || (r.width >= 44 && r.height >= 44), `touch target too small: ${JSON.stringify(r)}`);
      }
      await shot(page, '04-phone');
      await page.getByRole('button', { name: 'Зал даймё' }).tap();
      await page.waitForFunction(() => /#\/castles\/[0-9a-f-]+\/council$/.test(location.hash), null, { timeout: 20000 });
      await page.locator('.district-head').waitFor();
      step('телефон: нижняя панель разделов, список подразделений, карточка — нижний лист, вход в малый совет');
    },
    PHONE,
  );

  // 9. ADR-0030 through the real screen: the memory of the last visit and the service diagnostics panel.
  const ready = (page) => page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.w3d').waitFor({ timeout: 60000 });
    await ready(page);
    const k = await api(page, '/kingdom');
    const first = await page.evaluate(() => ({ seen: window.__world.seen, responses: window.__world.diagnostics().responses, keys: Object.keys(localStorage).filter((x) => x.startsWith('modus.city.seen.')) }));
    must(first.seen === null && first.responses === 0, 'the first visit on a device opens a still city');
    must(first.keys.length === 1, 'what was seen is remembered on the device, one record per person');
    must((await page.locator('.w3d-diag, .w3d-diag-chip').count()) === 0, 'the diagnostics panel is not part of the product screen');
    // «Last time» this person saw one castle a level lower, one envoy at another stage, and one envoy not yet on the road.
    const castle = k.castles.find((c) => c.level > 1);
    const [walker, fresh] = k.envoys.filter((e) => e.departmentId);
    must(castle && walker && fresh, 'the demo has a castle above level 1 and two envoys of departments');
    // Written and reloaded in one turn of the page: a refresh in between would store today's picture again.
    const was = await page.evaluate(({ key, castle, walker, fresh }) => {
      const m = JSON.parse(localStorage.getItem(key));
      m.levels[castle] -= 1;
      const t = m.envoys[walker].t;
      m.envoys[walker].t = t > 0.5 ? 0.2 : 0.9;
      delete m.envoys[fresh];
      localStorage.setItem(key, JSON.stringify(m));
      setTimeout(() => location.reload(), 0);
      return { now: t, then: m.envoys[walker].t };
    }, { key: first.keys[0], castle: castle.id, walker: String(walker.number), fresh: String(fresh.number) });
    await page.locator('.realm-toast', { hasText: castle.name }).waitFor({ timeout: 120000 });
    must((await page.locator('.realm-toast').innerText()).includes('Улучшение замка'), 'the growth since the last visit is announced in words');
    await page.waitForFunction(() => window.__world && window.__world.seen && window.__world.diagnostics().responses > 0, null, { timeout: 120000, polling: 50 });
    const told = await page.evaluate(({ castle, walker, fresh }) => {
      const w = window.__world;
      return { level: w.seen.levels[castle], walker: w.seen.envoys[`e${walker}`], fresh: w.seen.envoys[`e${fresh}`] ?? null };
    }, { castle: castle.id, walker: walker.number, fresh: fresh.number });
    must(told.level === castle.level - 1 && told.walker && Math.abs(told.walker.t - was.then) < 1e-9 && told.fresh === null, `the scene is told what was seen last time: ${JSON.stringify(told)}`);
    await shot(page, '08-since-last-visit');
    const end = await page.evaluate((walker) => {
      const w = window.__world;
      w.live = false;
      w.renderNow();
      const e = w.envoyItems.find((x) => x.id === `e${walker}`);
      return { responses: w.diagnostics().responses, t: e.t, walking: e.walking };
    }, walker.number);
    must(end.responses === 0 && Math.abs(end.t - was.now) < 1e-9 && !end.walking, `and everything ends where the server says it is: ${JSON.stringify(end)}`);
    must(Number(await page.locator('.w3d-stats dd').first().innerText()) === k.envoys.length, 'the counters still show the server numbers');
    step('память прошлого визита: выросший замок объявлен и «встаёт», гонец идёт от места, где его видели, новый появляется; всё кончается там, где говорит сервер');

    await page.goto(`${BASE}/#/kingdom?diag=1`);
    await page.reload();
    await page.locator('.w3d-diag').waitFor({ timeout: 120000 });
    await page.waitForFunction(() => /Программная отрисовка/.test(document.querySelector('.w3d-diag-verdict')?.textContent ?? ''), null, { timeout: 60000 });
    const diag = await page.locator('.w3d-diag').innerText();
    must(/Вызовы отрисовки\s+\d+ из 220/.test(diag) && /Треугольники\s+\d+ тыс\. из 450 тыс\./.test(diag) && diag.includes('SwiftShader'), `the panel reads this device against the budget: ${diag}`);
    must(diag.includes('служебная панель, в показ не входит'), 'and says it is not part of the show');
    for (const b of await page.locator('.w3d-diag button').all()) {
      const r = await b.boundingBox();
      must(!r || (r.width >= 44 && r.height >= 44), `diagnostics touch target too small: ${JSON.stringify(r)}`);
    }
    await shot(page, '09-diagnostics');
    await page.getByRole('button', { name: 'Свернуть диагностику' }).click();
    await page.locator('.w3d-diag-chip').click();
    await page.getByRole('button', { name: 'Убрать панель' }).click();
    must((await page.locator('.w3d-diag, .w3d-diag-chip').count()) === 0, 'the panel is removed');
    await page.goto(`${BASE}/#/kingdom`);
    await page.reload();
    await ready(page);
    must((await page.locator('.w3d-diag, .w3d-diag-chip').count()) === 0, 'and does not come back without ?diag=1');
    step('диагностика: только по ?diag=1, читает устройство по бюджету, программную отрисовку называет прямо, убирается');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.w3d').waitFor({ timeout: 60000 });
    await ready(page);
    const other = await page.evaluate(() => ({ seen: window.__world.seen, responses: window.__world.diagnostics().responses }));
    must(other.seen === null && other.responses === 0, 'the memory belongs to one person: a colleague on a new device sees a still city');
    step('память прошлого визита — у каждого своя');
  });

  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`\nВсе проверки 3D-города пройдены за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
  if (perf) console.log(`Замер в этой среде (программный WebGL SwiftShader, не видеокарта): медиана кадра ${perf.medianMs.toFixed(0)} мс, p90 ${perf.p90Ms.toFixed(0)} мс, ${perf.calls} вызовов, ${perf.triangles} треугольников, DPR ${perf.dpr}.`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (errors.length) console.error(`page errors: ${errors.join(' | ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
