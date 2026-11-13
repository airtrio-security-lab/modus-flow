import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../platform/db/pool.ts';
import { createApp } from '../../platform/http/app.ts';
import { issueToken } from '../../platform/http/auth.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { DEFAULT_LIMITS, voiceConfigFromEnv, type VoiceConfig } from '../../platform/modules/voice-realtime.ts';
import { realtimeToolSpecs, TOOL_NAMES } from '../../platform/modules/voice-tools.ts';
import { planTools } from '../../platform/modules/voice.ts';
import type { ModelConfig } from '../../platform/modules/advisor-model.ts';
import { createDraft, publishDraft } from '../../platform/modules/lab.ts';
import { freshDatabase, fullDraft, ownerQuery, world } from './support/db.ts';
import { ideaInReview } from './support/flow.ts';

/**
 * «Спросить советника» (ADR-0043). OpenAI is never called: a recording fake stands in for it.
 * What is checked: the key stays on the server, every session belongs to one person in one
 * organization, tools only read and only what the person may see, unknown tools fail, limits hold.
 */
const SECRET = 'test-secret-'.padEnd(48, 'x');
const KEY = 'sk-server-only-0000000000';
const EPHEMERAL = 'ek_short_lived_1111';
const SDP_OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n';
const SDP_ANSWER = 'v=0\r\no=- 9 9 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

let now = Date.now();
const calls: { url: string; auth: string; body: string }[] = [];
let failSecrets = 0;
let modelReply: unknown = null;
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  calls.push({ url, auth: headers.authorization ?? headers['x-api-key'] ?? '', body: String(init?.body ?? '') });
  if (url.endsWith('/realtime/client_secrets')) {
    if (failSecrets > 0) {
      failSecrets--;
      return new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 500 });
    }
    return new Response(JSON.stringify({ value: EPHEMERAL, expires_at: Math.floor(now / 1000) + 120, session: { id: 'sess_x' } }), { status: 200 });
  }
  if (url.endsWith('/realtime/calls')) return new Response(SDP_ANSWER, { status: 201, headers: { location: '/v1/realtime/calls/rtc_abc123' } });
  if (url.includes('/hangup')) return new Response('', { status: 200 });
  if (url.endsWith('/v1/messages')) return new Response(JSON.stringify(modelReply), { status: 200 });
  if (url.includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }] }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const voiceCfg: VoiceConfig = { provider: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-realtime', voice: 'cedar', apiKey: KEY, limits: { ...DEFAULT_LIMITS, maxSeconds: 300, sessionsPerHour: 6, toolCallsPerSession: 12 } };
const textModel: ModelConfig = { provider: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', apiKey: 'sk-ant-test' };

let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
const servers: Server[] = [];
let base: string; // voice on, no text model
let off: string; // nothing configured
let withModel: string; // voice on + text model
const logs: Record<string, unknown>[] = [];
let rejected: number;
let warehouse: number;

async function serve(cfg: Parameters<typeof createApp>[0]): Promise<string> {
  const s = createServer(createApp(cfg));
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  const common = { db, authSecret: SECRET, voiceFetch: fakeFetch, advisorFetch: fakeFetch, voiceNow: () => now, log: (e: Record<string, unknown>) => logs.push(e) };
  base = await serve({ ...common, voice: voiceCfg });
  off = await serve({ ...common });
  withModel = await serve({ ...common, voice: voiceCfg, advisorModel: textModel });
  rejected = await ideaInReview(db, w, 'Логистика: ночные рейсы на склад');
  await wf.decide(db, w.decider.actor, rejected, { outcome: 'reject', rationale: 'Ночная приёмка требует второго кладовщика, бюджета нет' });
  warehouse = await ideaInReview(db, w, 'Склад: очередь фур у рампы');
});
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await drop();
});

const tok = (p: { userId: string }) => issueToken(SECRET, p.userId);
async function call(root: string, method: string, path: string, opts: { token?: string; body?: unknown; sdp?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.sdp !== undefined) {
    headers['content-type'] = 'application/sdp';
    body = opts.sdp;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(root + '/api/v1' + path, { method, headers, body });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, type: res.headers.get('content-type') };
}
const start = (p: { userId: string }, org = 'acme', body: unknown = { language: 'ru' }, root = base) => call(root, 'POST', `/orgs/${org}/voice/sessions`, { token: tok(p), body });
const tool = (p: { userId: string }, sid: string, name: string, args: unknown = {}, org = 'acme', root = base) =>
  call(root, 'POST', `/orgs/${org}/voice/sessions/${sid}/tools`, { token: tok(p), body: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const end = (p: { userId: string }, sid: string, org = 'acme') => call(base, 'DELETE', `/orgs/${org}/voice/sessions/${sid}`, { token: tok(p) });

test('configuration: off by default; a cloud voice needs explicit consent, a key, and a second consent for real data', () => {
  assert.equal(voiceConfigFromEnv({}), null);
  assert.equal(voiceConfigFromEnv({ OPENAI_API_KEY: KEY }), null, 'a key alone connects nothing');
  const base = { MODUS_VOICE_PROVIDER: 'openai', OPENAI_API_KEY: KEY };
  assert.throws(() => voiceConfigFromEnv({ ...base, MODUS_DEMO_LOGIN: 'true' }), /MODUS_VOICE_ALLOW_REMOTE=true/);
  assert.throws(() => voiceConfigFromEnv({ ...base, MODUS_VOICE_ALLOW_REMOTE: 'true' }), /MODUS_VOICE_ALLOW_REAL_DATA=true/);
  assert.throws(() => voiceConfigFromEnv({ MODUS_VOICE_PROVIDER: 'openai', MODUS_VOICE_ALLOW_REMOTE: 'true', MODUS_DEMO_LOGIN: 'true' }), /не задан ключ/);
  assert.throws(() => voiceConfigFromEnv({ MODUS_VOICE_PROVIDER: 'twilio' }), /поддерживаются/);
  assert.throws(() => voiceConfigFromEnv({ ...base, MODUS_VOICE_ALLOW_REMOTE: 'true', MODUS_DEMO_LOGIN: 'true', MODUS_VOICE_MAX_SECONDS: '99999' }), /MODUS_VOICE_MAX_SECONDS/);
  const cfg = voiceConfigFromEnv({ ...base, MODUS_VOICE_ALLOW_REMOTE: 'true', MODUS_DEMO_LOGIN: 'true' })!;
  assert.deepEqual([cfg.model, cfg.voice, cfg.limits.maxSeconds, cfg.limits.maxPerUser], ['gpt-realtime', 'cedar', 600, 1]);
});

test('the tool list is closed, read-only and strictly typed', () => {
  const specs = realtimeToolSpecs();
  assert.deepEqual(specs.map((s) => s.name), TOOL_NAMES);
  for (const s of specs) {
    assert.equal(s.parameters.additionalProperties, false, `${s.name}: unknown arguments are refused`);
    assert.ok(!/^(create|update|delete|set|assign|approve|decide|reject|defer|publish|send)/.test(s.name), `${s.name} must not be a write`);
  }
  assert.ok(TOOL_NAMES.includes('get_my_summary') && TOOL_NAMES.includes('get_council_brief'));
});

test('not configured: honest «Голосовой AI не подключён», no session, no call outside', async () => {
  const st = await call(off, 'GET', '/orgs/acme/voice/status', { token: tok(w.author) });
  assert.equal(st.status, 200);
  assert.equal(st.json.voice.configured, false);
  assert.equal(st.json.note, 'Голосовой AI не подключён.');
  assert.equal(st.json.text.configured, false);
  const before = calls.length;
  const s = await start(w.author, 'acme', { language: 'ru' }, off);
  assert.equal(s.status, 503);
  assert.match(s.json.message, /не подключён/);
  assert.equal(calls.length, before, 'nothing was sent anywhere');
});

test('unauthenticated and foreign-organization requests are refused', async () => {
  assert.equal((await call(base, 'GET', '/orgs/acme/voice/status')).status, 401);
  assert.equal((await call(base, 'POST', '/orgs/acme/voice/sessions', { body: { language: 'ru' } })).status, 401);
  assert.equal((await call(base, 'POST', '/orgs/acme/voice/sessions', { token: 'demo-employee', body: {} })).status, 401);
  const before = calls.length;
  assert.equal((await start(w.outsider, 'acme')).status, 404, 'a member of another organization cannot start a session here');
  assert.equal(calls.length, before, 'no paid call for a refused request');
});

test('SDP: validated before anything leaves the server, relayed once with the short-lived secret', async () => {
  const s = await start(w.colleague, 'acme', { language: 'kk' });
  assert.equal(s.status, 201);
  assert.ok(!s.text.includes(KEY) && !s.text.includes(EPHEMERAL), 'no key, no secret in the reply');
  assert.deepEqual([s.json.language, s.json.voice, s.json.maxSeconds], ['kk', 'cedar', 300]);
  const secretCall = calls.filter((c) => c.url.endsWith('/client_secrets')).at(-1)!;
  assert.equal(secretCall.auth, `Bearer ${KEY}`);
  const sent = JSON.parse(secretCall.body);
  assert.equal(sent.session.audio.output.voice, 'cedar');
  assert.equal(sent.session.audio.input.transcription.language, 'kk');
  assert.equal(sent.session.audio.input.turn_detection.interrupt_response, true, 'speaking over the advisor interrupts it');
  assert.match(sent.session.instructions, /ТОЛЬКО ИЗ ИНСТРУМЕНТОВ/);
  assert.match(sent.session.instructions, /Альфред/, 'the advisor is called Alfred');
  assert.match(sent.session.instructions, /ты не человек/);
  assert.match(sent.session.instructions, /ВСТУПЛЕНИЕ/, 'Alfred opens with a report');
  assert.match(sent.session.instructions, /get_my_summary/);
  assert.match(sent.session.instructions, /openItemsVisible/);
  assert.match(sent.session.instructions, /қазақ/);
  assert.equal(sent.session.tools.length, TOOL_NAMES.length);

  const path = `/orgs/acme/voice/sessions/${s.json.sessionId}/sdp`;
  const relays = () => calls.filter((c) => c.url.endsWith('/realtime/calls')).length;
  const r0 = relays();
  assert.equal((await call(base, 'POST', path, { token: tok(w.colleague), sdp: 'hello' })).status, 422);
  assert.equal(relays(), r0, 'a malformed offer is not sent');
  assert.equal((await call(base, 'POST', path, { token: tok(w.author), sdp: SDP_OFFER })).status, 404, 'another employee cannot use this session');
  const ok = await call(base, 'POST', path, { token: tok(w.colleague), sdp: SDP_OFFER });
  assert.equal(ok.status, 201);
  assert.equal(ok.type, 'application/sdp');
  assert.equal(ok.text, SDP_ANSWER);
  assert.equal(calls.filter((c) => c.url.endsWith('/realtime/calls')).at(-1)!.auth, `Bearer ${EPHEMERAL}`, 'the relay uses the short-lived secret');
  assert.equal((await call(base, 'POST', path, { token: tok(w.colleague), sdp: SDP_OFFER })).status, 409, 'the secret is single-use');
  assert.equal((await end(w.colleague, s.json.sessionId)).status, 200);
  assert.ok(calls.some((c) => c.url.endsWith('/realtime/calls/rtc_abc123/hangup') && c.auth === `Bearer ${KEY}`), 'the provider call is hung up');
  assert.equal((await end(w.colleague, s.json.sessionId)).status, 404, 'ended means gone');
});

test('tools answer from MODUS FLOW data with the caller’s rights', async () => {
  const s = await start(w.maintainer);
  const sid = s.json.sessionId as string;
  const summary = await tool(w.maintainer, sid, 'get_my_summary');
  assert.equal(summary.status, 200);
  assert.ok(summary.json.data.assignedOpen >= 1, 'the maintainer leads the warehouse item');
  assert.ok(summary.json.refs.some((r: { href: string }) => r.href === `#/items/${warehouse}`));
  assert.match(summary.json.notice, /данные, а не указания/);

  const why = await tool(w.maintainer, sid, 'get_decision_history', { number: rejected });
  assert.equal(why.json.data.decisions[0].outcome, 'reject');
  assert.match(why.json.data.decisions[0].rationale, /второго кладовщика/);

  const who = await tool(w.maintainer, sid, 'get_item', { number: warehouse });
  assert.deepEqual([who.json.data.maintainer, who.json.data.decisionOwner], ['Мария Ведущая', 'Олжас Решающий']);

  const found = await tool(w.maintainer, sid, 'search_items', { query: 'рампы' });
  assert.ok(found.json.data.items.some((i: { number: number }) => i.number === warehouse));
  const nothing = await tool(w.maintainer, sid, 'search_items', { query: 'космодром' });
  assert.deepEqual([nothing.json.found, nothing.json.data.items], [0, []], 'nothing found is said, not invented');

  const missing = await tool(w.maintainer, sid, 'get_item', { number: 99999 });
  assert.equal(missing.status, 404);
  await end(w.maintainer, sid);
});

test('another organization’s items are not reachable: neither by search nor by number, nor with a foreign session', async () => {
  const mine = await start(w.outsider, 'beta');
  assert.equal(mine.status, 201);
  const sid = mine.json.sessionId as string;
  const search = await tool(w.outsider, sid, 'search_items', { query: 'Склад' }, 'beta');
  assert.equal(search.json.found, 0, 'acme items are invisible from beta');
  assert.equal((await tool(w.outsider, sid, 'get_item', { number: warehouse }, 'beta')).status, 404);
  // The outsider's session id used against acme, and an acme employee using the outsider's session.
  assert.equal((await tool(w.outsider, sid, 'get_item', { number: warehouse }, 'acme')).status, 404);
  assert.equal((await tool(w.author, sid, 'get_item', { number: warehouse }, 'acme')).status, 404);
  await end(w.outsider, sid, 'beta');
});

test('changing data by voice is impossible: unknown tools fail loudly, drafts are proposals only', async () => {
  const s = await start(w.decider);
  const sid = s.json.sessionId as string;
  const count = async () => (await ownerQuery<{ d: number; x: number; i: number }>(db, 'SELECT (SELECT count(*) FROM decisions)::int AS d, (SELECT count(*) FROM lab_drafts)::int AS x, (SELECT count(*) FROM ideas)::int AS i'))[0]!;
  const before = await count();
  for (const name of ['decide_item', 'set_status', 'assign_maintainer', 'approve', 'create_item']) {
    const r = await tool(w.decider, sid, name, { number: warehouse, outcome: 'merge' });
    assert.equal(r.status, 400, name);
    assert.equal(r.json.error, 'unsupported_tool');
    assert.notEqual(r.json.success, true, 'never a fake success');
  }
  // Extra fields smuggled into a read tool are refused, not ignored.
  assert.equal((await tool(w.decider, sid, 'get_item', { number: warehouse, userId: w.admin.userId })).status, 422);
  assert.equal((await tool(w.decider, sid, 'get_item', 'not json')).status, 422);

  const draft = await tool(w.decider, sid, 'prepare_initiative_draft', { kind: 'idea', title: 'Резервный слот у рампы', proposal: 'Держать один слот свободным для опоздавших' });
  assert.equal(draft.status, 200);
  assert.deepEqual([draft.json.proposal.saved, draft.json.proposal.requiresConfirmation], [false, true]);
  const question = await tool(w.decider, sid, 'prepare_council_question', { number: warehouse, text: 'Нужно ли выделить второй слот разгрузки утром?' });
  assert.equal(question.json.proposal.kind, 'council_question');
  assert.deepEqual(await count(), before, 'no decision, draft or item was created');
  await end(w.decider, sid);
});

test('limits: one conversation per person, an hourly cap, a tool-call cap, a time limit', async () => {
  const a = await start(w.admin);
  assert.equal(a.status, 201);
  const second = await start(w.admin);
  assert.equal(second.status, 429);
  assert.match(second.json.message, /уже идёт разговор/);
  for (let i = 0; i < 12; i++) assert.equal((await tool(w.admin, a.json.sessionId, 'get_council_open_items')).status, 200);
  assert.equal((await tool(w.admin, a.json.sessionId, 'get_council_open_items')).status, 429, 'tool-call cap');
  await end(w.admin, a.json.sessionId);

  // Time limit: after the deadline the session is gone for tools as well.
  const b = await start(w.admin);
  now += 301_000;
  assert.equal((await tool(w.admin, b.json.sessionId, 'get_my_summary')).status, 404);
  // Hourly cap (6 in this configuration): 2 used above; 4 more start and end; the 7th is refused.
  for (let i = 0; i < 4; i++) {
    const c = await start(w.admin);
    assert.equal(c.status, 201, `start ${i}`);
    await end(w.admin, c.json.sessionId);
  }
  const capped = await start(w.admin);
  assert.equal(capped.status, 429);
  assert.match(capped.json.message, /в час/);
  now += 3601_000;
  const again = await start(w.admin);
  assert.equal(again.status, 201, 'the hourly window moves on');
  await end(w.admin, again.json.sessionId);
});

test('provider failure: an honest 503, the error text of the provider is not echoed, the slot is free again', async () => {
  failSecrets = 1;
  const r = await start(w.colleague);
  assert.equal(r.status, 503);
  assert.ok(!r.text.includes(KEY));
  assert.match(r.json.message, /ошибку 500/);
  const ok = await start(w.colleague);
  assert.equal(ok.status, 201, 'a failed start does not hold the one-conversation slot');
  await end(w.colleague, ok.json.sessionId);
});

test('council round table: context is checked with the employee’s rights before any paid call', async () => {
  const before = calls.length;
  const hidden = await start(w.author, 'acme', { language: 'ru', context: { kind: 'council', number: 99999 } });
  assert.equal(hidden.status, 404);
  assert.equal(calls.length, before);
  const s = await start(w.author, 'acme', { language: 'ru', context: { kind: 'council', number: warehouse } });
  assert.equal(s.status, 201);
  const sent = JSON.parse(calls.filter((c) => c.url.endsWith('/client_secrets')).at(-1)!.body);
  assert.match(sent.session.instructions, new RegExp(`№${warehouse}`));
  assert.match(sent.session.instructions, /не участник голосования/);
  const brief = await tool(w.author, s.json.sessionId, 'get_council_brief', { number: warehouse });
  assert.equal(brief.status, 200);
  assert.match(brief.json.data.reminder, /не голосует и не решает/);
  await end(w.author, s.json.sessionId);
});

test('text alternative: without a model the facts are shown as facts; with a model the links are limited to the facts', async () => {
  const plain = await call(base, 'POST', '/orgs/acme/voice/ask', { token: tok(w.maintainer), body: { question: `Почему отклонили предложение номер ${rejected}?` } });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.method, 'none');
  assert.equal(plain.json.answer, null, 'no template pretending to be AI');
  assert.ok(plain.json.facts.some((f: { tool: string }) => f.tool === 'get_decision_history'));

  modelReply = { content: [{ type: 'text', text: JSON.stringify({ answer: 'Отклонили: нужен второй кладовщик, бюджета нет.', refs: [rejected, 424242] }) }] };
  const ai = await call(withModel, 'POST', '/orgs/acme/voice/ask', { token: tok(w.maintainer), body: { question: `Почему отклонили предложение номер ${rejected}?` } });
  assert.equal(ai.json.method, 'model');
  assert.match(ai.json.answer, /кладовщик/);
  assert.ok(!ai.json.refs.some((r: { id: string }) => r.id === '424242'), 'a link to an item that was not among the facts is dropped');
  assert.equal(ai.json.refs[0].id, String(rejected));
  assert.equal((await call(base, 'POST', '/orgs/acme/voice/ask', { token: tok(w.outsider), body: { question: 'Что требует внимания?' } })).status, 404);
});

test('planning a typed question uses only read tools', () => {
  assert.deepEqual(planTools('Что сегодня требует моего внимания?').map((p) => p.name), ['get_my_summary']);
  assert.ok(planTools('Кто сейчас отвечает за задачу номер 42?').some((p) => p.name === 'get_item' && p.args.number === 42));
  assert.ok(planTools('Какие обращения склада просрочены?').some((p) => p.name === 'search_items' && p.args.overdue === true));
  assert.ok(planTools('Какие инициативы принесли подтверждённую пользу?').some((p) => p.name === 'list_confirmed_impact'));
  for (const q of ['Удали обращение 5', 'Назначь Марию ответственной', 'Утверди решение по 7']) for (const p of planTools(q)) assert.ok(TOOL_NAMES.includes(p.name));
});

test('logs and replies never carry the key, the secret or what was said', async () => {
  const s = await start(w.author);
  await tool(w.author, s.json.sessionId, 'search_items', { query: 'секретный текст сотрудника' });
  await end(w.author, s.json.sessionId);
  const all = JSON.stringify(logs);
  assert.ok(!all.includes(KEY) && !all.includes(EPHEMERAL));
  assert.ok(!all.includes('секретный текст сотрудника'), 'tool arguments are not logged');
  assert.ok(logs.some((l) => l.voice === 'tool' && l.tool === 'search_items'));
});

test('a private lab draft stays private: no voice tool reads it', async () => {
  const d = await createDraft(db, w.colleague.userId, { ...fullDraft, title: 'Личный черновик про премии' });
  const s = await start(w.maintainer);
  const r = await tool(w.maintainer, s.json.sessionId, 'search_items', { query: 'премии' });
  assert.equal(r.json.found, 0);
  await end(w.maintainer, s.json.sessionId);
  await publishDraft(db, w.colleague.userId, d.id, { organization: 'acme' });
});

test('form of address: only the employee\'s own choice; business style has none; the opening report uses it', async () => {
  const { ownerQuery: q } = await import('./support/db.ts');
  const instr = async () => JSON.parse(calls.filter((c) => c.url.endsWith('/client_secrets')).at(-1)!.body).session.instructions as string;
  const setPref = (form: string, style = 'royal') =>
    q(db, `INSERT INTO notification_preferences (organization_id, membership_id, style, address_form) VALUES ($1, $2, $3, $4)
            ON CONFLICT (organization_id, membership_id) DO UPDATE SET style = EXCLUDED.style, address_form = EXCLUDED.address_form`, [w.acmeId, w.colleague.membershipId, style, form]);
  await setPref('milord');
  let s = await start(w.colleague);
  assert.match(await instr(), /обращайся к сотруднику «мой милорд»/);
  assert.match(await instr(), /обратись «мой милорд»/);
  await end(w.colleague, s.json.sessionId);
  await setPref('milady');
  s = await start(w.colleague);
  assert.match(await instr(), /«моя миледи»/);
  assert.doesNotMatch(await instr(), /милорд/, 'never the other form');
  await end(w.colleague, s.json.sessionId);
  await setPref('milord', 'business');
  s = await start(w.colleague);
  assert.match(await instr(), /деловой стиль — без игровых обращений/);
  assert.doesNotMatch(await instr(), /милорд/);
  await end(w.colleague, s.json.sessionId);

  const t = await start(w.maintainer);
  const summary = await tool(w.maintainer, t.json.sessionId, 'get_my_summary');
  assert.equal(typeof summary.json.data.openItemsVisible, 'number', '«у нас N обращений» — a real count');
  assert.equal(typeof summary.json.data.overdueItemsVisible, 'number');
  await end(w.maintainer, t.json.sessionId);
});
