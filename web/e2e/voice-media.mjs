/**
 * The live-voice path in a real Chromium against the TEST HARNESS (test/platform/support/voice-harness.ts):
 * the voice advisor is switched on, the provider refuses the WebRTC connection. No paid call, no speech.
 * Checked in the browser, not in emulation of the transport:
 *  - microphone denied → an honest message, no server session is even created;
 *  - microphone granted (Chromium's fake device) → server session → SDP relay → provider unavailable →
 *    honest error, «Переподключить», every microphone track is stopped, the server slot is free again;
 *  - the page never sees a provider key or secret; tool calls without a session are refused.
 *   BASE=http://127.0.0.1:3198 node web/e2e/voice-media.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { signIn } from './sign-in.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3198';
const OUT = process.env.SHOTS ?? 'docs/demo/voice-advisor';
mkdirSync(OUT, { recursive: true });
const people = JSON.parse(readFileSync(process.env.PERSONAS ?? '.demo/personas.json', 'utf8')).personas;
const person = people.find((p) => p.title === 'Кладовщик') ?? people[0];
const t0 = Date.now();
const step = (name) => console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} с  ${name}`);
const fail = (m) => {
  throw new Error(m);
};

async function open(browser, ctxOpts) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...ctxOpts });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  const bodies = [];
  page.on('response', async (r) => {
    if (r.url().includes('/voice/')) bodies.push(await r.text().catch(() => ''));
  });
  // Keep every microphone stream the page gets, to check later that all tracks were stopped.
  await page.addInitScript(() => {
    window.__streams = [];
    const md = navigator.mediaDevices;
    if (md?.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      md.getUserMedia = async (c) => {
        const s = await orig(c);
        window.__streams.push(s);
        return s;
      };
    }
  });
  await page.goto(BASE);
  await signIn(page, person);
  await page.waitForSelector('.shell');
  await page.getByRole('button', { name: 'Спросить Альфреда' }).click();
  const panel = page.getByRole('dialog', { name: 'Альфред' });
  await panel.getByRole('button', { name: /Начать разговор/ }).waitFor();
  return { ctx, page, panel, requests, bodies };
}

// 1) Microphone denied.
{
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream'] });
  const { ctx, page, panel, requests } = await open(browser, { permissions: [] });
  await panel.getByRole('button', { name: /Начать разговор/ }).click();
  await panel.getByText(/Доступ к микрофону запрещён|Микрофон не найден|Не удалось включить микрофон/).waitFor({ timeout: 8000 });
  if (requests.some((r) => r.url.includes('/voice/sessions') && r.method === 'POST')) fail('сессия создана, хотя микрофон запрещён');
  await panel.getByRole('button', { name: 'Переподключить' }).waitFor();
  step('микрофон запрещён: честное сообщение, серверная сессия не создавалась, платного вызова нет');
  await page.screenshot({ path: `${OUT}/05-mic-denied.png` });
  await ctx.close();
  await browser.close();
}

// 2) Microphone granted, provider unavailable.
{
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const { ctx, page, panel, requests, bodies } = await open(browser, { permissions: ['microphone'] });
  await panel.getByRole('button', { name: /Начать разговор/ }).click();
  await panel.getByText(/ошибку 503/).waitFor({ timeout: 10000 });
  const posted = requests.filter((r) => r.url.includes('/voice/sessions') && r.method === 'POST').map((r) => r.url.replace(/.*\/voice\//, ''));
  if (!posted.some((u) => u === 'sessions') || !posted.some((u) => u.endsWith('/sdp'))) fail(`ожидались сессия и SDP через сервер: ${posted}`);
  if (requests.some((r) => /openai\.com|provider\.invalid/.test(r.url))) fail('браузер обратился к провайдеру напрямую');
  if (bodies.some((b) => /ek_harness_only|harness-key-never-real/.test(b))) fail('секрет или ключ попал в браузер');
  step('микрофон разрешён → сессия и SDP только через сервер MODUS FLOW → провайдер недоступен: «ошибка 503»');
  const live = await page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length);
  const total = await page.evaluate(() => window.__streams.length);
  if (!total) fail('микрофон не запрашивался');
  if (live) fail(`${live} дорожек микрофона остались включёнными`);
  step(`все дорожки микрофона остановлены (${total} поток)`);
  await page.screenshot({ path: `${OUT}/06-provider-down.png` });

  // Reconnect: the slot was freed (no «уже идёт разговор»), the same honest error again.
  await panel.getByRole('button', { name: 'Переподключить' }).click();
  await page.waitForTimeout(300);
  await panel.getByText(/ошибку 503/).waitFor({ timeout: 10000 });
  if (await panel.getByText(/уже идёт разговор/).count()) fail('слот не освобождён после ошибки');
  step('переподключение: слот свободен, ошибка показана честно, без имитации ответа');

  // A tool call without a live session is refused by the server.
  const refused = await page.evaluate(async () => {
    const token = sessionStorage.getItem('modus.token');
    const r = await fetch('/api/v1/orgs/modus-demo/voice/sessions/00000000-0000-4000-8000-000000000000/tools', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'get_my_summary', arguments: '{}' }),
    });
    return r.status;
  });
  if (refused !== 404) fail(`инструмент без сессии: ${refused}`);
  step('вызов инструмента без живой сессии — 404');

  await page.getByRole('button', { name: /Закрыть панель Альфреда/ }).click();
  const after = await page.evaluate(() => window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState !== 'ended').length);
  if (after) fail('после закрытия панели микрофон включён');
  step('панель закрыта — микрофон выключен');
  await ctx.close();
  await browser.close();
}
console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с. Снимки: ${OUT}/`);
