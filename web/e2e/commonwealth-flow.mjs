/**
 * «Дворец, Великая библиотека и Высший Архив» through the real UI (ADR-0034): the three buildings of
 * the centre on the schematic map and in the 3D city, the halls of the Library, one volume in the
 * reading view and the new-record form — on a desktop and on a phone, without sideways scrolling.
 *
 * Nothing is drawn from mock data. The scenario first makes sure the demo database has knowledge on
 * every level; whatever is missing it registers through the same public API a person would use, and
 * every level change is an act of the person with the right role.
 *
 * Needs a seeded demo database and the demo server:   npm run demo:commonwealth
 * SHOTS=<dir> saves the pictures; WebGL here is SwiftShader, so the 3D pictures say nothing about speed.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS ?? null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const whHead = by('Начальник склада');
const storekeeper = by('Кладовщик');
const engineer = by('Сервисный инженер');
const archivist = by('Архивариус');
const owner = by('Собственник компании');

// Two browsers: software WebGL is needed only for the 3D city, and it cannot capture long phone pages.
const browser = await chromium.launch();
const gl = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const shot = async (page, name, opts = {}) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, ...opts }) : undefined);

// SHOT_SCALE=1 keeps the pictures for docs/demo small; 2 is for a close look.
const SCALE = Number(process.env.SHOT_SCALE ?? 2);
async function as(person, fn, { viewport = { width: 1280, height: 900 }, view = 'city', mobile = false, scale = SHOTS ? SCALE : 1 } = {}) {
  const ctx = await (view === '3d' ? gl : browser).newContext({ viewport, deviceScaleFactor: scale, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem('modus.kingdom.view', v);
      localStorage.setItem('modus.howto.hidden', '1');
      localStorage.setItem('modus.lite', '0');
      localStorage.setItem('modus.w3d.hint', '1');
      localStorage.setItem('modus.w3d.quality', 'medium');
    } catch {
      /* storage unavailable */
    }
  }, view);
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
const act = async (page, id, action, reason) => ok(await apiCall(page, 'POST', `/knowledge/${id}/actions`, { action, reason }), action);
/** No sideways scrolling of the page itself; deliberately scrollable strips are allowed. */
const noSideScroll = async (page, what) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  must(over <= 1, `${what}: страница шире экрана на ${over} px`);
};

const LESSON = 'Почему общий чат заявок на ремонт не прижился';
const METHOD = 'Контрольный список перед выездом сервисной бригады';
const HERITAGE = 'Печать этикеток у ворот приёмки';

try {
  // ---- 0. Knowledge on every level, registered through the public API when it is missing ----
  const ids = await as(archivist, async (page) => {
    const list = ok(await apiCall(page, 'GET', '/knowledge'), 'list').items;
    return Object.fromEntries([LESSON, METHOD, HERITAGE].map((t) => [t, list.find((i) => i.title === t)?.id ?? null]));
  });
  if (!ids[LESSON] || !ids[METHOD] || !ids[HERITAGE]) {
    const made = await as(storekeeper, async (page) => {
      const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
      const wh = { categoryId: dir.categories.find((c) => c.name === 'Склад и логистика').id, departmentId: dir.departments.find((d) => d.name === 'Склад и логистика').id };
      const item = async (title, problem) => ok(await apiCall(page, 'POST', '/ideas', { kind: 'problem', title, problem, ...wh }), 'item').item.number;
      return {
        chat: ids[LESSON] ? null : await item('Заявки на ремонт теряются в общем чате', 'Заявки на ремонт техники пишут в общий чат склада, часть остаётся без ответа'),
        list: ids[METHOD] ? null : await item('Бригада выезжает без нужного инструмента', 'Сервисная бригада возвращается за инструментом: перед выездом никто не сверяет комплект'),
        gate: ids[HERITAGE] ? null : await item('Машины ждут приёмки из-за печати этикеток', 'Этикетки печатают на одном компьютере в конторе, машины стоят у ворот около 40 минут'),
        gate2: ids[HERITAGE] ? null : await item('Очередь у ворот №2 из-за печати этикеток', 'У ворот №2 та же очередь из-за печати этикеток в конторе'),
      };
    });
    await as(whHead, async (page) => {
      const dir = ok(await apiCall(page, 'GET', '/directory'), 'directory');
      const member = (name) => dir.members.find((m) => m.name === name).membershipId;
      const register = async (kind, title, card, numbers) => ok(await apiCall(page, 'POST', '/knowledge', { kind, title, card, sources: numbers.map((number) => ({ type: 'idea', number })) }), `register ${title}`).id;
      const decide = async (n, rationale, who) => ok(await apiCall(page, 'POST', `/ideas/${n}/decision`, { outcome: 'merge', rationale, implementer: member(who) }), 'decide');
      if (made.chat) {
        ids[LESSON] = await register('lesson', LESSON, {
          problem: 'Заявки на ремонт техники писали в общий чат склада. За смену чат уходил вверх, и часть заявок оставалась без ответа.',
          options: 'Оставить чат и назначить дежурного; завести отдельный чат ремонта; подавать заявки обращением с ответственным.',
          argumentsFor: 'Чат уже есть у всех, ничего не нужно внедрять.',
          argumentsAgainst: 'В чате нет ответственного и срока: непонятно, кто взял заявку и взял ли.',
          decision: 'Сначала оставили общий чат и назначили дежурного по смене.',
          reasons: 'Казалось, что дежурного достаточно и новый порядок не понадобится.',
          results: 'Дежурный не успевал читать чат во время приёмки. Заявки продолжали теряться, от схемы отказались.',
          negative: 'Канал без ответственного и срока не работает, даже если его читают все.',
          positive: 'Стало видно, сколько заявок на самом деле приходит за смену.',
        }, [made.chat]);
      }
      if (made.list) {
        await decide(made.list, 'Ввести контрольный список комплекта перед выездом', engineer.name);
        ids[METHOD] = await register('method', METHOD, {
          problem: 'Сервисная бригада возвращалась на склад за инструментом: комплект перед выездом никто не сверял.',
          options: 'Собирать комплект по памяти; закрепить ящик за каждой бригадой; сверять комплект по списку перед выездом.',
          argumentsFor: 'Список занимает три минуты и не требует закупок.',
          argumentsAgainst: 'Ещё одна бумага, которую могут заполнять формально.',
          decision: 'Перед выездом бригадир сверяет комплект по единому контрольному списку и отмечает это в обращении.',
          reasons: 'Самый дешёвый способ убрать возвраты; список легко поправить под новый тип работ.',
          actions: [{ what: 'Составить список для трёх типовых выездов' }, { what: 'Повесить список у стеллажа с инструментом' }],
        }, [made.list]);
        await act(page, ids[METHOD], 'library_proposed', 'Решение принято, порядок описан');
      }
      if (made.gate) {
        await decide(made.gate, 'Пилот у ворот №1 с запасным принтером', engineer.name);
        await decide(made.gate2, 'Повторяем проверенный метод на воротах №2', whHead.name);
        ok(await apiCall(page, 'POST', `/ideas/${made.gate2}/implementation`, { report: 'Ворота №2: приёмка 14 минут' }), 'complete 2');
        ids[HERITAGE] = await register('method', HERITAGE, {
          problem: 'Машины ждали приёмки около 40 минут: этикетки печатались только в конторе.',
          options: 'Печать в конторе; мобильный принтер у ворот; предварительная печать по заявке поставщика.',
          argumentsFor: 'Дешёвый принтер, этикетка печатается там, где товар.',
          argumentsAgainst: 'Поломка единственного принтера остановит приёмку.',
          decision: 'Печатать этикетку со сканера на мобильный принтер у ворот, держать запасной принтер.',
          reasons: 'Самый быстрый вариант при низкой цене; риск закрыт запасным принтером.',
        }, [made.gate]);
        await act(page, ids[HERITAGE], 'library_proposed', 'Решение принято и внедрено, результат известен');
      }
    });
    if (made.gate) await as(engineer, async (page) => ok(await apiCall(page, 'POST', `/ideas/${made.gate}/implementation`, { report: 'Принтер у ворот №1 работает: приёмка машины — 12 минут вместо 40' }), 'complete'));
    await as(archivist, async (page) => {
      if (made.list) await act(page, ids[METHOD], 'library_accepted', 'Проверила решение и порядок действий');
      if (made.gate) {
        const id = ids[HERITAGE];
        await act(page, id, 'library_accepted', 'Проверила отчёт о внедрении и решение');
        ok(await apiCall(page, 'POST', `/knowledge/${id}/applications`, { ideaNumber: made.gate2, note: 'Тот же метод на воротах №2' }), 'application');
        const view = ok(await apiCall(page, 'GET', `/knowledge/${id}`), 'view');
        ok(
          await apiCall(page, 'POST', `/knowledge/${id}/versions`, {
            title: view.title,
            reason: 'Заключение для Высшего Архива',
            card: {
              ...view.card,
              results: 'Приёмка машины: 40 → 12 минут на воротах №1, 14 минут на воротах №2.',
              positive: 'Печать у места приёмки убрала очередь.',
              negative: 'Первую неделю без запасного принтера был простой на 20 минут.',
              archiveCategory: 'method',
              proof: `Отчёты о внедрении №${made.gate} и №${made.gate2}, одинаковый результат.`,
              applicability: 'Склады с приёмкой у ворот и сканерами с Bluetooth.',
              basis: 'Метод воспроизведён на втором участке с тем же эффектом.',
              lastChecked: '2026-11-11',
            },
          }),
          'version',
        );
        await act(page, id, 'archive_proposed', 'Метод воспроизведён дважды');
      }
    });
    if (made.gate) await as(owner, async (page) => act(page, ids[HERITAGE], 'archive_approved', 'Утверждаю включение'));
  }
  step('0. знания на трёх уровнях есть: урок в Летописи, метод в Библиотеке решений, наследие в Высшем Архиве');

  // ---- 1. The schematic map: the palace, the library and the archive ----
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.realm-map svg').waitFor();
    const clip = async (href, pad = 26) => {
      const b = await page.locator(`.realm-map a[href="${href}"]`).boundingBox();
      return { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 };
    };
    await page.locator('.realm-map').scrollIntoViewIfNeeded();
    await shot(page, '01-map', { clip: await page.locator('.realm-map').boundingBox() });
    await shot(page, '02-map-palace', { clip: await clip('#/council') });
    await shot(page, '03-map-library', { clip: await clip('#/library') });
    await shot(page, '04-map-archive', { clip: await clip('#/library?hall=archive') });
    // The palace is a link: keyboard and touch reach the council without hover.
    await page.locator('.realm-map a[href="#/council"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/#\/council$/, { timeout: 8000 });
  }, { viewport: { width: 1440, height: 1100 }, scale: SHOTS ? SCALE + 1 : 1 });
  step('1. схема города: дворец, библиотека и архив на месте; дворец открывает Совет с клавиатуры');

  // ---- 2. The 3D city: the same three buildings ----
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/kingdom`);
    await page.locator('.w3d').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.w3d-loading') && window.__world, null, { timeout: 120000 });
    const look = (id, tweak) =>
      page.evaluate(`(() => { const w = window.__world; w.live = false; const v = w.viewOf(${JSON.stringify(id)}); w.setView(Object.assign(v, ${JSON.stringify(tweak ?? {})})); w.renderNow(); })()`);
    await look('palace', { dist: 190, az: 0.5, pol: 1.02 });
    await shot(page, '05-3d-palace');
    await look('palace', { dist: 520, az: 0.2, pol: 0.95 });
    await shot(page, '06-3d-centre');
    await look('library');
    await shot(page, '07-3d-library');
    await look('archive');
    await shot(page, '08-3d-archive');
  }, { viewport: { width: 1280, height: 800 }, view: '3d', scale: 1 });
  step('2. 3D-город: дворец, библиотека и архив построены');

  // ---- 3. The Library: halls, search, catalogue ----
  const settle = (page) => page.waitForTimeout(260); // the door of a hall lights up over 180 ms
  await as(storekeeper, async (page) => {
    // From the map: the building opens the library, the address stays plain.
    await page.goto(`${BASE}/#/kingdom`);
    await page.getByRole('link', { name: /Великая библиотека: Летопись/ }).click();
    await page.waitForURL(/#\/library$/);
    await page.getByRole('heading', { level: 1, name: 'Великая библиотека' }).waitFor();
    await page.locator('.volume').first().waitFor();
    must(!(await page.getByRole('link', { name: 'Создать запись' }).count()), 'кладовщик видит «Создать запись», хотя вносить в Летопись ему нельзя');
    await shot(page, '10-library', { fullPage: true });

    // A hall is a door: the catalogue, the header and the address follow it.
    await page.getByRole('button', { name: /Библиотека решений/ }).click();
    await page.waitForURL(/#\/library\?hall=library$/);
    await page.getByRole('heading', { level: 1, name: 'Библиотека решений' }).waitFor();
    must((await page.locator('.volume').count()) === (await page.locator('.volume[data-level="library"]').count()), 'в зале «Библиотека решений» показаны записи других залов');
    await settle(page);
    await shot(page, '11-hall-library', { fullPage: true });
    await page.getByRole('button', { name: /Высший Архив/ }).click();
    await page.waitForURL(/#\/library\?hall=archive$/);
    await page.locator('.volume', { hasText: HERITAGE }).getByText('Утверждено как наследие').waitFor();
    await page.locator('.volume', { hasText: HERITAGE }).getByText('Основания включения').waitFor();
    await settle(page);
    await shot(page, '12-hall-archive', { fullPage: true });
    await page.getByRole('button', { name: /Все залы/ }).click();
    await page.waitForURL(/#\/library$/);

    // Search: by words, across the halls; the address keeps the query; nothing found is said plainly.
    const search = page.getByLabel('Какое решение или опыт вы ищете?');
    await search.fill('этикет');
    await page.locator('.volume', { hasText: HERITAGE }).waitFor();
    await page.locator('.volume', { hasText: LESSON }).waitFor({ state: 'detached' });
    await page.waitForURL(/#\/library\?q=/);
    await page.getByText(/^Найдено: \d+/).waitFor();
    await page.reload();
    await page.locator('.volume', { hasText: HERITAGE }).waitFor();
    must((await page.getByLabel('Какое решение или опыт вы ищете?').inputValue()) === 'этикет', 'после перезагрузки запрос из адреса не восстановлен');
    await page.getByLabel('Какое решение или опыт вы ищете?').fill('звездолёт');
    await page.getByText('По вашему запросу среди доступных знаний ничего не найдено').waitFor();
    await shot(page, '16-nothing-found');
    await page.getByRole('button', { name: 'Очистить поиск' }).click();
    await page.locator('.volume', { hasText: LESSON }).waitFor();
    await page.waitForURL(/#\/library$/);

    // One volume: the reading view, the passport, the sources, the way back.
    await page.locator('.volume', { hasText: HERITAGE }).click();
    await page.getByRole('heading', { level: 1, name: HERITAGE }).waitFor();
    for (const t of ['Суть знания', 'Исходная проблема', 'Рассмотренные варианты', 'Почему выбрали это решение', 'Что было сделано', 'Какой результат получили', 'Чему научились', 'Где метод применим', 'Доказательства и источники'])
      await page.getByRole('heading', { level: 2, name: t }).waitFor();
    await page.getByRole('heading', { level: 2, name: 'Паспорт знания' }).waitFor();
    await page.getByRole('img', { name: /Печать Высшего Архива/ }).waitFor();
    must(!(await page.getByRole('button', { name: /Утвердить|Внести в Библиотеку|Отметить как устаревшее/ }).count()), 'кладовщик видит действия, которые сервер ему не разрешал');
    await page.waitForTimeout(400);
    await shot(page, '13-volume-archive', { fullPage: true });
    await page.getByRole('link', { name: /^№\d+ «Машины ждут приёмки/ }).first().click();
    await page.waitForURL(/#\/items\/\d+$/);
    await page.goBack();
    await page.getByRole('link', { name: 'К каталогу зала «Высший Архив»' }).click();
    await page.waitForURL(/#\/library\?hall=archive$/);

    // A lesson in the Chronicle: negative experience is kept and shown, not hidden.
    await page.goto(`${BASE}/#/library/${ids[LESSON]}`);
    await page.getByRole('heading', { level: 1, name: LESSON }).waitFor();
    await page.getByText('Зарегистрировано, не проверено').first().waitFor();
    await page.getByText('Канал без ответственного и срока не работает').first().waitFor();
    await page.waitForTimeout(400);
    await shot(page, '14-volume-chronicle', { fullPage: true });
    // A volume that does not exist or is closed: no content, a way back.
    await page.goto(`${BASE}/#/library/00000000-0000-4000-8000-000000000000`);
    await page.getByText('Этот том вам недоступен').waitFor();
    await page.getByRole('link', { name: 'Вернуться в Содружество' }).click();
    await page.waitForURL(/#\/kingdom$/);
  }, { viewport: { width: 1440, height: 900 } });
  await as(whHead, async (page) => {
    await page.goto(`${BASE}/#/library`);
    await page.getByRole('link', { name: 'Создать запись' }).click();
    await page.waitForURL(/#\/library\/new$/);
    await page.getByLabel('Название').waitFor();
    for (const t of ['Что мы хотим сохранить?', 'Откуда это известно?', 'Какой опыт получили?', 'Сохранение']) await page.getByRole('group', { name: t }).waitFor();
    must(await page.getByRole('button', { name: 'Внести в Летопись' }).isDisabled(), 'запись без названия можно отправить');
    await shot(page, '15-new', { fullPage: true });
  });
  // The archivist sees the acts the server allows for the role, on the same page.
  await as(archivist, async (page) => {
    await page.goto(`${BASE}/#/library/${ids[METHOD]}`);
    await page.getByRole('heading', { level: 2, name: 'Действия' }).waitFor();
    await page.getByRole('button', { name: 'Запросить повторную проверку' }).waitFor();
    await shot(page, '17-archivist-actions');
  });
  // A tablet and the dark theme.
  await as(storekeeper, async (page) => {
    await page.goto(`${BASE}/#/library`);
    await page.locator('.volume').first().waitFor();
    await noSideScroll(page, 'Библиотека, 768 px');
    await shot(page, '18-tablet-library', { fullPage: true });
    await page.goto(`${BASE}/#/library/${ids[HERITAGE]}`);
    await page.getByRole('heading', { level: 1, name: HERITAGE }).waitFor();
    await noSideScroll(page, 'том, 768 px');
  }, { viewport: { width: 768, height: 1024 } });
  await as(storekeeper, async (page) => {
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.goto(`${BASE}/#/library?hall=archive`);
    await page.locator('.volume').first().waitFor();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await settle(page);
    await shot(page, '19-dark-archive', { fullPage: true });
    await page.goto(`${BASE}/#/library/${ids[HERITAGE]}`);
    await page.getByRole('heading', { level: 1, name: HERITAGE }).waitFor();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(400);
    await shot(page, '19-dark-volume', { fullPage: true });
  }, { viewport: { width: 1280, height: 900 } });
  step('3. Библиотека: вход с карты, залы и адрес, поиск и «ничего не найдено», том с паспортом и источниками, урок Летописи, недоступный том, форма новой записи, действия Архивариуса, планшет и тёмная тема');

  // ---- 4. Phones: 375 and 320 px, no sideways scrolling ----
  for (const w of [375, 320]) {
    await as(storekeeper, async (page) => {
      await page.goto(`${BASE}/#/library`);
      await page.locator('.volume').first().waitFor();
      await noSideScroll(page, `Библиотека, ${w} px`);
      await shot(page, `20-phone-${w}-library`, { fullPage: true });
      await page.goto(`${BASE}/#/library/${ids[HERITAGE]}`);
      await page.getByRole('heading', { level: 1, name: HERITAGE }).waitFor();
      await noSideScroll(page, `том, ${w} px`);
      await shot(page, `21-phone-${w}-volume`, { fullPage: true });
    }, { viewport: { width: w, height: 780 }, mobile: true });
  }
  step('4. телефон 375 и 320 px: каталог и том без прокрутки вбок');

  must(!errors.length, `ошибки на странице: ${errors.join('; ')}`);
  console.log(`ГОТОВО: дворец, библиотека и архив пройдены за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
} catch (e) {
  console.error(`ОШИБКА: ${e.message}`);
  if (errors.length) console.error(`ошибки страницы: ${errors.join('; ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await gl.close();
}
