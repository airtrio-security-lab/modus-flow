/**
 * Phones and tablets for what ADR-0042 added (owner request 2026-11-13: «обязательно чекни на мобильных
 * устройствах и адаптируй»):
 *   - the scenes «Великий Совет собран!» and «Ваш вклад признан» (video and still frame);
 *   - «Вклад» in the item passport: «Подтвердить вклад», the second step, the confirmed mark;
 *   - where «Войти в заседание» leads (the meeting screen).
 * On every device: nothing wider than the screen, every control a finger-size target (≥ 44 px) and
 * inside the screen, the title and the text readable (not cut), the safe areas respected.
 *
 * Chromium with device profiles (viewport, pixel ratio, touch, mobile). Safari/WebKit is not run here.
 * Needs a freshly seeded demo database and the demo server:
 *   npm run demo:seed && npm run demo:start  →  npm run demo:mobile-new
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const SHOTS = process.env.SHOTS;
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const by = (title) => people.find((p) => p.title === title) ?? (() => { throw new Error(`persona ${title}`); })();
const storekeeper = by('Кладовщик');
const lead = by('Начальник склада');
const ops = by('Операционный директор');

const DEVICES = [
  { name: 'iPhone SE 1 · 320×568', viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 },
  { name: 'Galaxy S8 · 360×740', viewport: { width: 360, height: 740 }, deviceScaleFactor: 3 },
  { name: 'iPhone SE · 375×667', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 },
  { name: 'iPhone 13 · 390×844', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: 'Pixel 7 · 412×915', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 },
  { name: 'iPhone 14 Pro Max · 430×932', viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 },
  { name: 'iPhone SE landscape · 667×375', viewport: { width: 667, height: 375 }, deviceScaleFactor: 2 },
  { name: 'iPhone 13 landscape · 844×390', viewport: { width: 844, height: 390 }, deviceScaleFactor: 3 },
  { name: 'iPad Mini · 768×1024', viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2 },
];
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const problems = [];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const must = (cond, msg) => {
  if (!cond) problems.push(msg);
};
const slug = (s) => s.split(' · ')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function open(dev, before) {
  const ctx = await browser.newContext({ viewport: dev.viewport, deviceScaleFactor: dev.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: UA, reducedMotion: dev.reducedMotion });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${dev.name}: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.setItem('modus.lite', '0');
    localStorage.setItem('modus.howto.hidden', '1');
  });
  if (before) await page.evaluate(before);
  return { ctx, page };
}
async function signIn(page, person) {
  await page.evaluate(() => sessionStorage.removeItem('modus.token'));
  await page.goto(`${BASE}/#/`);
  await page.reload();
  await page.getByRole('button', { name: new RegExp(person.name) }).click();
  await page.waitForSelector('.shell');
  await page.waitForFunction(() => document.documentElement.dataset.cineChecked === '1', null, { timeout: 15000 });
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
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

/** Layout facts of the open scene, measured in the page. */
const sceneFacts = (page) =>
  page.evaluate(() => {
    const d = document.querySelector('dialog.cine[open]');
    const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const frame = d.querySelector('.cine-frame');
    const h2 = d.querySelector('h2');
    return {
      vw: innerWidth,
      vh: innerHeight,
      scrollX: document.documentElement.scrollWidth - innerWidth,
      dialog: r(d),
      dialogScrolls: d.scrollHeight > d.clientHeight + 1,
      frame: r(frame),
      h2: r(h2),
      h2Cut: h2 ? h2.scrollWidth > h2.clientWidth + 1 : false,
      copyFont: parseFloat(getComputedStyle(d.querySelector('.cine-copy p') ?? d).fontSize),
      buttons: [...d.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), ...b.getBoundingClientRect().toJSON() })),
    };
  });

function checkScene(dev, f, label) {
  const tag = `${dev.name} · ${label}`;
  must(f.scrollX <= 1, `${tag}: horizontal scroll ${f.scrollX}px`);
  must(f.dialog.left >= -1 && f.dialog.right <= f.vw + 1 && f.dialog.top >= -1 && f.dialog.bottom <= f.vh + 1, `${tag}: the scene leaves the screen ${JSON.stringify(f.dialog)}`);
  must(!f.dialogScrolls, `${tag}: the scene has to be scrolled to reach its buttons`);
  if (f.frame) must(f.frame.height >= Math.min(220, f.vh * 0.45), `${tag}: the picture is too small (${Math.round(f.frame.height)} px high)`);
  must(!f.h2Cut, `${tag}: the title is cut`);
  must(f.copyFont >= 14, `${tag}: text smaller than 14 px (${f.copyFont})`);
  for (const b of f.buttons) {
    must(b.height >= 44, `${tag}: «${b.text}» is ${Math.round(b.height)} px high`);
    must(b.left >= 0 && b.right <= f.vw + 0.5 && b.top >= 0 && b.bottom <= f.vh + 0.5, `${tag}: «${b.text}» is outside the screen`);
  }
  // No two controls overlap (the sound switch rides on the picture on phones).
  for (const [i, a] of f.buttons.entries())
    for (const b of f.buttons.slice(i + 1))
      must(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${tag}: «${a.text}» overlaps «${b.text}»`);
}

try {
  // ---- Real facts once: a Great Round Table session on, a contribution of the storekeeper confirmed.
  const setup = await open(DEVICES[3]);
  await signIn(setup.page, storekeeper);
  const storeId = (await setup.page.evaluate(async () => (await (await fetch('/api/v1/me', { headers: { authorization: `Bearer ${sessionStorage.getItem('modus.token')}` } })).json()).memberships[0].membershipId));
  await signIn(setup.page, lead);
  let target = null;
  for (let n = 1; n <= 40 && !target; n++) {
    const it = await api(setup.page, `/ideas/${n}`).catch(() => null);
    const c = it?.contributions?.find((x) => x.member === storekeeper.name && x.canConfirm);
    if (c) target = { n, c };
  }
  if (!target) throw new Error('no recorded contribution of the storekeeper led by the warehouse head');
  await signIn(setup.page, ops);
  const great = await api(setup.page, '/meetings', { method: 'POST', json: { title: 'Большой Круглый стол: приёмка у ворот и сверка с поставщиками', participants: [storeId], organizerConsent: true } });
  await signIn(setup.page, storekeeper);
  await api(setup.page, `/meetings/${great.id}/consent`, { method: 'POST', json: { consent: 'given' } });
  await signIn(setup.page, ops);
  await api(setup.page, `/meetings/${great.id}/recording/start`, { method: 'POST', json: {} });
  await setup.ctx.close();
  step(`данные: заседание Большого Круглого стола идёт, вклад кладовщика в №${target.n} ждёт подтверждения`);

  // ---- 1. «Вклад» in the passport, as the lead: the button, the second step — on every device.
  for (const dev of DEVICES) {
    const { ctx, page } = await open(dev);
    await signIn(page, lead);
    for (let i = 0; i < 4 && (await page.locator('dialog.cine[open], .cine-text').count()); i++)
      await page.locator('dialog.cine[open], .cine-text').getByRole('button', { name: /^(Пропустить|Позже|Закрыть)$/ }).first().click();
    await page.goto(`${BASE}/#/items/${target.n}`);
    const line = page.locator('.credit-line', { hasText: storekeeper.name });
    await line.scrollIntoViewIfNeeded();
    const ask = line.getByRole('button', { name: 'Подтвердить вклад' });
    await ask.waitFor({ timeout: 15000 });
    await ask.click();
    await line.getByRole('button', { name: 'Да, подтвердить' }).scrollIntoViewIfNeeded();
    const f = await page.evaluate(() => {
      const l = [...document.querySelectorAll('.credit-line')].find((x) => x.querySelector('.credit-ask'));
      return {
        vw: innerWidth,
        scrollX: document.documentElement.scrollWidth - innerWidth,
        line: l.getBoundingClientRect().toJSON(),
        overflow: [...l.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').length,
        buttons: [...l.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), ...b.getBoundingClientRect().toJSON() })),
        font: parseFloat(getComputedStyle(l.querySelector('.credit-ask .small')).fontSize),
      };
    });
    const tag = `${dev.name} · паспорт`;
    must(f.scrollX <= 1, `${tag}: horizontal scroll ${f.scrollX}px`);
    must(f.line.right <= f.vw + 0.5, `${tag}: the line leaves the screen`);
    must(f.font >= 13, `${tag}: the warning is ${f.font} px`);
    for (const b of f.buttons) {
      must(b.height >= 44, `${tag}: «${b.text}» is ${Math.round(b.height)} px high`);
      must(b.width >= 44, `${tag}: «${b.text}» is ${Math.round(b.width)} px wide`);
      must(b.right <= f.vw + 0.5 && b.left >= 0, `${tag}: «${b.text}» is outside the screen`);
    }
    // The two buttons of the second step must not touch: a finger must not hit the wrong one.
    if (f.buttons.length === 2) {
      const [a, b] = f.buttons;
      const gap = a.top === b.top ? b.left - a.right : Math.abs(b.top - a.bottom);
      must(gap >= 8, `${tag}: «${a.text}» and «${b.text}» are ${Math.round(gap)} px apart`);
    }
    await shot(page, `passport-ask-${slug(dev.name)}`);
    await line.getByRole('button', { name: 'Отмена' }).click();
    step(`${dev.name}: «Подтвердить вклад» и второй шаг в паспорте`);
    await ctx.close();
  }

  // The real confirmation, once, then the confirmed mark on the smallest phone.
  {
    const { ctx, page } = await open(DEVICES[0]);
    await signIn(page, lead);
    for (let i = 0; i < 4 && (await page.locator('dialog.cine[open], .cine-text').count()); i++)
      await page.locator('dialog.cine[open], .cine-text').getByRole('button', { name: /^(Пропустить|Позже|Закрыть)$/ }).first().click();
    await page.goto(`${BASE}/#/items/${target.n}`);
    const line = page.locator('.credit-line', { hasText: storekeeper.name });
    await line.getByRole('button', { name: 'Подтвердить вклад' }).click();
    await line.getByRole('button', { name: 'Да, подтвердить' }).click();
    await line.locator('.credit-confirmed').waitFor({ timeout: 10000 });
    await line.scrollIntoViewIfNeeded();
    const f = await page.evaluate(() => ({
      vw: innerWidth,
      scrollX: document.documentElement.scrollWidth - innerWidth,
      mark: document.querySelector('.credit-confirmed').getBoundingClientRect().toJSON(),
    }));
    must(f.scrollX <= 1 && f.mark.right <= f.vw + 0.5, `320: the confirmed mark leaves the screen ${JSON.stringify(f.mark)}`);
    await shot(page, 'passport-confirmed-320');
    step('320 px: подтверждено, отметка «✓ подтверждён: …» помещается');
    await ctx.close();
  }

  // ---- 2. The two scenes on every device, as the storekeeper (each device is new: it starts quiet,
  // so the facts are fed again as fixtures carrying the real ids).
  const inbox = await (async () => {
    const { ctx, page } = await open(DEVICES[3]);
    await signIn(page, storekeeper);
    const list = await api(page, '/notifications');
    await ctx.close();
    return list;
  })();
  const real = ['meeting_recording_started', 'contribution_confirmed'].map((e) => inbox.find((n) => n.event === e));
  if (real.some((n) => !n)) throw new Error(`real notifications missing: ${real.map((n) => n?.event)}`);
  let seq = 0;
  for (const dev of DEVICES) {
    for (const motion of dev.viewport.width === 390 ? ['no-preference', 'reduce'] : ['no-preference']) {
      const { ctx, page } = await open({ ...dev, reducedMotion: motion });
      await signIn(page, storekeeper);
      const fixtures = real.map((n) => ({ ...n, id: `fixture-mobile-${++seq}`, readAt: null, createdAt: new Date(Date.now() + 1000).toISOString(), meeting: n.meeting ? { ...n.meeting, recordingStartedAt: new Date(Date.now() + 1000).toISOString() } : null }));
      await page.route('**/api/v1/orgs/*/notifications', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: [...fixtures, ...(await res.json())] });
      });
      await page.reload();
      for (const [i, scene] of [['great-council-gathered', 'Войти в заседание'], ['contribution-recognized', 'Открыть обращение']].entries()) {
        const d = page.locator('dialog.cine[open]');
        await d.waitFor({ timeout: 20000 });
        if (motion === 'reduce') await d.locator('img.cine-media').waitFor({ timeout: 10000 });
        else
          await page.waitForFunction((s) => {
            const v = document.querySelector('dialog.cine[open] video');
            return v && (v.currentSrc || v.src).endsWith(`/cinematics/${s}.mp4`) && v.currentTime > 0.3;
          }, scene[0], { timeout: 20000 });
        checkScene(dev, await sceneFacts(page), `${scene[0]} (${motion === 'reduce' ? 'кадр' : 'видео'}, во время показа)`);
        if (motion !== 'reduce') await page.waitForFunction(() => document.querySelector('dialog.cine[open] video')?.ended, null, { timeout: 15000 });
        await page.waitForTimeout(400); // the buttons change with a short colour transition
        checkScene(dev, await sceneFacts(page), `${scene[0]} (после показа)`);
        await shot(page, `${scene[0]}-${slug(dev.name)}${motion === 'reduce' ? '-still' : ''}`);
        if (i === 0) {
          const next = d.getByRole('button', { name: /^Дальше:/ });
          if (await next.count()) await next.click();
          else await d.getByRole('button', { name: /^(Пропустить|Закрыть)$/ }).first().click();
        } else {
          await d.getByRole('button', { name: scene[1] }).click();
        }
      }
      step(`${dev.name}${motion === 'reduce' ? ' (уменьшить движение)' : ''}: «Великий Совет собран!» и «Ваш вклад признан»`);
      await ctx.close();
    }
  }

  // ---- 3. Where «Войти в заседание» leads, on the smallest phone and in landscape.
  for (const dev of [DEVICES[0], DEVICES[7]]) {
    const { ctx, page } = await open(dev);
    await signIn(page, storekeeper);
    await page.goto(`${BASE}/#/meetings/${great.id}`);
    await page.locator('main h1').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    const x = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    must(x <= 1, `${dev.name} · заседание: horizontal scroll ${x}px`);
    await shot(page, `meeting-${slug(dev.name)}`);
    step(`${dev.name}: экран заседания после «Войти в заседание»`);
    await ctx.close();
  }

  if (errors.length) problems.push(...errors.map((e) => `page error: ${e}`));
  if (problems.length) {
    console.error(`\n✗ ${problems.length} problem(s):\n- ${[...new Set(problems)].join('\n- ')}`);
    process.exitCode = 1;
  } else console.log(`\nТелефоны и планшет: новое проверено на ${DEVICES.length} устройствах за ${((Date.now() - t0) / 1000).toFixed(1)} с.`);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (problems.length) console.error(`- ${problems.join('\n- ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
