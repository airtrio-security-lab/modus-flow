/**
 * «Живое Королевство» through the real UI (owner brief 2026-11-11, ADR-0019): the city with its
 * camera, the districts in different styles, the castle opening into the department screen, staff
 * cards with privacy, real actions (assign, invite to the Council), the style picker with its log,
 * the workspace without the map, and the phone layout. Every fact is read back from the screen.
 * Needs a freshly seeded demo database:  npm run demo:city  (BASE and PERSONAS override defaults)
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const whHead = by('Начальник склада');
const sysAdmin = by('Администратор системы');

const browser = await chromium.launch();
const errors = [];
const t0 = Date.now();
const DESK = { viewport: { width: 1440, height: 950 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function as(person, fn, opts = DESK, lite = '0') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.evaluate((v) => localStorage.setItem('modus.lite', v), lite);
  await page.reload();
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
const viewBox = (page) => page.locator('.realm-map svg').getAttribute('viewBox');
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const apiCall = (page, method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api/v1/orgs/modus-demo${path}`, {
        method,
        headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, path, body },
  );
const ok = (r, what) => {
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const warehouse = (page) => page.locator('.realm-castle[aria-label*="«Склад и логистика»"]');

try {
  let districtUrl = '';
  // 1. The city: districts in different styles, the camera, keyboard, the castle opens the district.
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.waitForSelector('.realm-map svg');
    const castles = await page.locator('.realm-castle').count();
    must(castles === 8, `castles: ${castles}`);
    for (const civ of ['Японский сёгунат', 'Казахское ханство', 'Монгольская держава', 'Камелот']) must((await page.locator(`.realm-castle[aria-label*="${civ}"]`).count()) > 0, `no district in style ${civ}`);
    for (const place of ['Большой Круглый стол', 'Великая библиотека', 'Высший Архив', 'Площадь достижений']) await page.locator('.realm-place', { hasText: place }).first().waitFor();
    step('город: 8 районов в четырёх стилях, Совет, Библиотека, Архив, Площадь достижений');

    const full = await viewBox(page);
    await page.getByRole('button', { name: 'К Совету' }).click();
    await page.waitForFunction((v) => document.querySelector('.realm-map svg')?.getAttribute('viewBox') !== v, full);
    await page.waitForTimeout(700);
    const zoomed = (await viewBox(page)).split(' ').map(Number);
    must(zoomed[2] < Number(full.split(' ')[2]) / 2, `zoom: ${zoomed}`);
    // Bounds: dragging far away never leaves the city.
    const box = await page.locator('.realm-map svg').boundingBox();
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 2000, box.y + 2000, { steps: 8 });
    await page.mouse.up();
    const dragged = (await viewBox(page)).split(' ').map(Number);
    must(dragged[0] >= 0 && dragged[1] >= 0, `out of bounds: ${dragged}`);
    await page.getByRole('button', { name: 'Весь город' }).click();
    await page.waitForFunction((v) => document.querySelector('.realm-map svg')?.getAttribute('viewBox') === v, full);
    await page.locator('.realm-map').focus();
    await page.keyboard.press('+');
    must((await viewBox(page)) !== full, 'keyboard zoom');
    await page.keyboard.press('0');
    must((await viewBox(page)) === full, 'keyboard reset');
    step('камера: полёт к Совету, перетаскивание в границах, «Весь город», клавиатура');

    await warehouse(page).click();
    await page.waitForURL(/#\/castles\/[0-9a-f-]{36}/);
    districtUrl = page.url().split('#')[1].split('/').slice(0, 3).join('/');
    await page.locator('.district-head h1', { hasText: 'Склад и логистика' }).waitFor();
    await expectText(page, 'Казахское ханство');
    for (const g of ['Командование', 'Специалисты', 'Основной состав', 'Потребности отдела']) await page.getByRole('heading', { name: new RegExp(g) }).waitFor();
    const text = (await page.locator('.district').textContent()) ?? '';
    for (const secret of ['Адресное хранение', 'Только дневные смены', 'Хочу вести обучение', 'Утренние смены']) must(!text.includes(secret), `leaked to a peer: ${secret}`);
    must(text.includes('Приёмка'), 'own skills are visible to the person');
    must((await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).textContent()).includes('Анкета видна самому сотруднику и руководителям'), 'peer questionnaire must be hidden');
    must((await page.locator('.staff-card').first().textContent()).includes('Нет данных'), 'unknown load must read «Нет данных»');
    must((await page.getByRole('button', { name: 'Сменить стиль района' }).count()) === 0, 'storekeeper must not change the style');
    await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).click();
    must((await page.getByRole('link', { name: 'Пригласить в Совет' }).count()) === 0, 'storekeeper cannot call a council');
    must((await page.getByRole('heading', { name: 'Назначить задачу' }).count()) === 0, 'storekeeper cannot assign');
    await page.keyboard.press('Escape');
    step('замок открывает район: стиль «Казахское ханство», группы состава; чужие анкеты скрыты, загрузка «Нет данных», лишних кнопок нет');

    // Cinematic entry from a royal message: through the city to the palace, skippable at once.
    await page.goto(`${BASE}/#/inbox`);
    await page.locator('li.scroll', { hasText: 'Планёрка склада' }).first().getByRole('button', { name: 'Войти в Совет' }).click();
    await page.locator('.realm-cinema', { hasText: 'Входим: Ханская юрта' }).waitFor();
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await page.waitForURL(/#\/(meetings|council)\/[0-9a-f-]+$/);
    step('«Войти в Совет»: камера летит к дворцу, «Пропустить» сразу открывает заседание');
  });

  // 2. The head: skills of the staff, a real assignment and an invitation to the Council.
  // Preparation through the existing workflow: an item of the warehouse decided «внедрять» by its head.
  const assigned = await as(storekeeper, async (page) => {
    const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
    const wh = { cat: dir.categories.find((c) => c.name === 'Склад и логистика').id, dep: dir.departments.find((d) => d.name === 'Склад и логистика').id };
    return ok(await apiCall(page, 'POST', '/ideas', { kind: 'idea', title: 'Стеллаж для возвратов у ворот №1', problem: 'Возвраты стоят в проходе и мешают приёмке', proposal: 'Поставить отдельный стеллаж для возвратов', categoryId: wh.cat, departmentId: wh.dep }), 'item').item.number;
  });
  await as(whHead, async (page) => {
    const me = ok(await apiCall(page, 'GET', '/directory'), 'directory').members.find((m) => m.name === whHead.name).membershipId;
    ok(await apiCall(page, 'POST', `/ideas/${assigned}/decision`, { outcome: 'merge', rationale: 'Стеллаж есть на складе, место у ворот свободно', implementer: me }), 'decide');
  });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#${districtUrl}/staff`);
    await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).waitFor();
    must((await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).textContent()).includes('Адресное хранение'), 'lead sees skills');
    must(!((await page.locator('.district').textContent()) ?? '').includes('Только дневные смены'), 'preferences never on cards');
    await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('heading', { name: 'Назначить задачу' }).waitFor();
    await sheet.locator('select').selectOption(String(assigned));
    await sheet.getByRole('button', { name: 'Назначить исполнителем' }).click();
    await sheet.getByText(`назначен(а) исполнителем обращения №${assigned}`).waitFor();
    step(`глава назначил Ержана исполнителем обращения №${assigned} — существующим правилом`);
    await sheet.getByRole('link', { name: 'Пригласить в Совет' }).click();
    await page.waitForURL(/#\/meetings\/new\?participant=/);
    must(await page.locator('.pick-list label', { hasText: 'Ержан Мусин' }).locator('input').isChecked(), 'invited person preselected');
    step('«Пригласить в Совет» открывает созыв заседания с выбранным сотрудником');

    await page.goto(`${BASE}/#${districtUrl}/staff`);
    await page.locator('.staff-card', { hasText: 'Ержан Мусин' }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Профиль' }).click();
    await page.waitForURL(/#\/people\//);
    await page.locator('#person-tasks').getByText(`№${assigned}`).waitFor();
    must(!((await page.locator('.person-page').textContent()) ?? '').includes('Хочу вести обучение'), 'preferences only for the person');
    step('профиль сотрудника: задача видна, предпочтения скрыты от руководителя');

    // Tabs read the same facts.
    await page.goto(`${BASE}/#${districtUrl}/tasks`);
    await page.locator('.kan-col', { hasText: 'Внедряется' }).getByText(`Обращение №${assigned}`).waitFor();
    await page.getByRole('tab', { name: /Наследие/ }).click();
    await expectText(page, 'Цветная разметка зон приёмки и отгрузки');
    await page.getByRole('tab', { name: /Совет/ }).click();
    await expectText(page, 'Планёрка склада');
    step('вкладки «Задачи», «Совет», «Наследие» показывают реальные записи');

    // The style: a picture, logged, no XP change.
    await page.goto(`${BASE}/#${districtUrl}/growth`);
    const xpBefore = await page.locator('.district-head .xpbar .small').textContent();
    await page.getByRole('button', { name: 'Сменить стиль района' }).click();
    await page.getByRole('radio', { name: /Камелот/ }).click();
    must((await page.locator('.sheet .civ-levels li').count()) === 5, 'five levels preview');
    await page.getByRole('button', { name: 'Выбрать «Камелот»' }).click();
    await page.locator('.district-head', { hasText: 'Камелот' }).waitFor();
    await page.locator('.district-list', { hasText: 'Казахское ханство → Камелот' }).waitFor();
    must((await page.locator('.district-head .xpbar .small').textContent()) === xpBefore, 'XP must not change with the style');
    // Camelot has an actual interactive city, not only a decorative district illustration.
    await page.goto(`${BASE}/#${districtUrl}`);
    await page.locator('.camelot-town-viewport').waitFor();
    must((await page.locator('.camelot-town-hotspot').count()) === 8, 'Camelot must have eight clickable buildings');
    await page.locator('.camelot-warriors').click();
    await page.waitForURL(/#\/castles\/[0-9a-f-]{36}\/warriors$/);
    await page.getByRole('heading', { name: /Зал воинов/ }).first().waitFor();
    await page.goto(`${BASE}/#${districtUrl}`);
    await page.locator('.camelot-council').click();
    await page.waitForURL(/#\/castles\/[0-9a-f-]{36}\/council$/);
    await page.getByRole('heading', { name: /У малого совета/ }).waitFor();
    step('Камелот: панорама, восемь кликабельных зданий, Зал воинов и Совет');
    await page.goto(`${BASE}/#${districtUrl}/growth`);
    await page.getByRole('button', { name: 'Сменить стиль района' }).click();
    await page.getByRole('radio', { name: /Казахское ханство/ }).click();
    await page.getByRole('button', { name: 'Выбрать «Казахское ханство»' }).click();
    await page.locator('.district-head', { hasText: 'Казахское ханство' }).waitFor();
    step('глава сменил стиль: превью пяти уровней, запись в журнале, опыт не изменился (стиль возвращён)');
  });

  // 3. The commonwealth's name is the organization's setting (ADR-0021); the real company name stays in administration.
  await as(sysAdmin, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('heading', { name: 'Великое Содружество', level: 1 }).waitFor();
    await page.goto(`${BASE}/#/settings`);
    await page.getByLabel('Название Содружества').fill('Содружество Модус');
    await page.getByRole('button', { name: 'Сохранить название' }).click();
    await page.waitForLoadState('load');
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('heading', { name: 'Содружество Модус', level: 1 }).waitFor();
    await page.locator('.realm-cartouche', { hasText: 'Содружество Модус' }).waitFor();
    must(((await page.locator('.shell').textContent()) ?? '').includes('Модус Трейд — демо'), 'the real company name stays in the interface frame');
    await page.goto(`${BASE}/#/settings`);
    await page.getByLabel('Название Содружества').fill('Великое Содружество');
    await page.getByRole('button', { name: 'Сохранить название' }).click();
    await page.waitForLoadState('load');
    step('админ переименовал Содружество; реальное название компании осталось в администрировании (название возвращено)');
  });

  // 4. Admin's workspace: the same departments without the map, remembered after reload.
  await as(sysAdmin, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('button', { name: 'Рабочее пространство' }).click();
    await page.locator('table.work-table').waitFor();
    must((await page.locator('.realm-map').count()) === 0, 'workspace has no map');
    await page.reload();
    await page.locator('table.work-table').waitFor();
    await page.locator('table.work-table a', { hasText: 'Склад и логистика' }).click();
    await page.locator('.district-head').waitFor();
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('button', { name: 'Город' }).click();
    await page.locator('.realm-map svg').waitFor();
    step('«Рабочее пространство»: таблица без карты, выбор запоминается, ведёт в тот же район');
  });

  // 5. Phone: lite graphics, the castle opens a full-screen panel, the card is a bottom sheet.
  await as(
    whHead,
    async (page) => {
      await page.goto(`${BASE}/#/kingdom`);
      await page.waitForSelector('.realm-map svg');
      const full = await viewBox(page);
      await warehouse(page).dispatchEvent('click');
      await page.waitForURL(/#\/castles\//);
      await page.locator('.district-head').waitFor();
      await page.goto(`${BASE}/#/kingdom`);
      must((await viewBox(page)) !== full, 'camera remembers the castle it flew to');
      await page.getByRole('button', { name: 'Весь город' }).click();
      must((await viewBox(page)) === full, 'lite mode resets instantly');
      await page.goto(`${BASE}/#${districtUrl}/staff`);
      const strip = await page.locator('.staff-grid.is-strip').evaluate((el) => getComputedStyle(el).gridAutoFlow);
      must(strip === 'column', `leadership strip: ${strip}`);
      await page.locator('.staff-card', { hasText: 'Ирина Волкова' }).click();
      const b = await page.locator('.sheet').boundingBox();
      must(Math.abs(b.y + b.height - 844) < 2 && b.width >= 389, `bottom sheet: ${JSON.stringify(b)}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      must(overflow <= 0, `horizontal scroll on phone: ${overflow}`);
      step('телефон: облегчённая графика без анимации, полоса руководства, карточка — нижняя панель');
    },
    PHONE,
    '1',
  );

  if (errors.length) throw new Error(`ошибки в браузере: ${errors.join('; ')}`);
  console.log(`Сценарий «Живое Королевство» пройден за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
