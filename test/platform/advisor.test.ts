import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as advisor from '../../platform/modules/advisor.ts';
import { modelConfigFromEnv, type ModelConfig } from '../../platform/modules/advisor-model.ts';
import { extractByRules, validateQuotes } from '../../platform/domain/protocol.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * MODUS ADVISOR (ADR-0013): proposes from a meeting protocol and from
 * questionnaires; a person confirms every fact; it never decides, never
 * awards XP and never assigns credit by itself.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));

export const PROTOCOL = `Планёрка склада, 12 ноября
Присутствовали: Олег Киселев, Асель Темирова, Руслан Исаев

Асель Темирова: этикетки приходится печатать на отдельном компьютере, на каждую машину уходит 3–4 минуты.
Руслан Исаев: сканер у ворот №2 зависает на холоде, вводим коды вручную.
Олег Киселев: обсудили график смен, вопросов нет.

Решили:
- Проверить печать этикеток со сканера на мобильный принтер у ворот
- Купить запасной принтер для ворот №1 (поднял: Руслан Исаев)

Разное:
Обед в 13:00.`;

test('rules find tasks with exact quotes and skip small talk', () => {
  const found = extractByRules(PROTOCOL);
  assert.equal(found.length, 4);
  for (const k of found) assert.equal(PROTOCOL.slice(k.quoteStart, k.quoteEnd), k.quote);
  assert.deepEqual(found.map((k) => [k.kind, k.raiser]), [
    ['problem', 'Асель Темирова'],
    ['problem', 'Руслан Исаев'],
    ['idea', null],
    ['idea', 'Руслан Исаев'],
  ]);
  assert.ok(!found.some((k) => /график смен|Обед/.test(k.quote)));
  assert.equal(found[3]!.title, 'Купить запасной принтер для ворот №1');
});

test('model output is kept only when the quote is literally in the protocol', () => {
  const r = validateQuotes(PROTOCOL, [
    { quote: 'Купить запасной принтер для ворот №1 (поднял: Руслан Исаев)', title: 'Запасной принтер', kind: 'idea' },
    { quote: 'Уволить кладовщика за опоздания', title: 'Выдумано', kind: 'problem' },
    { quote: 42 },
  ]);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.dropped, 2);
  const k = r.candidates[0]!;
  assert.equal(PROTOCOL.slice(k.quoteStart, k.quoteEnd), k.quote);
});

test('a protocol is stored verbatim with its hash; only leads parse and read it', async () => {
  await assert.rejects(advisor.createProtocol(db, w.author.actor, { title: 'Планёрка', text: PROTOCOL, method: 'rules' }, undefined, null), codes('forbidden'));
  const r = await advisor.createProtocol(db, w.maintainer.actor, { title: 'Планёрка склада', text: PROTOCOL, method: 'rules' }, 'key-proto-1', null);
  assert.equal(r.status, 201);
  assert.equal(r.body.candidates, 4);
  const again = await advisor.createProtocol(db, w.maintainer.actor, { title: 'Планёрка склада', text: PROTOCOL, method: 'rules' }, 'key-proto-1', null);
  assert.equal(again.replayed, true);
  const [row] = await ownerQuery<{ source_text: string; source_sha256: string; method: string }>(db, 'SELECT source_text, source_sha256, method FROM meeting_protocols WHERE id = $1', [r.body.id]);
  assert.equal(row!.source_text, PROTOCOL);
  assert.equal(row!.source_sha256, createHash('sha256').update(PROTOCOL).digest('hex'));
  assert.equal(row!.method, 'rules');
  // An employee sees neither the protocol nor its candidates.
  assert.equal((await asUser(w.author, 'SELECT id FROM meeting_protocols')).rowCount, 0);
  assert.equal((await asUser(w.author, 'SELECT id FROM protocol_candidates')).rowCount, 0);
  assert.equal((await asUser(w.outsider, 'SELECT id FROM meeting_protocols')).rowCount, 0);
  const p = await advisor.getProtocol(db, w.decider.actor, r.body.id);
  assert.equal(p.methodLabel, 'Разбор по шаблону (без ИИ)');
  assert.equal(p.candidates.length, 4);
  // The source is append-only.
  await assert.rejects(ownerQuery(db, "UPDATE meeting_protocols SET source_text = 'x' WHERE id = $1", [r.body.id]));
});

test('the database refuses a quote that is not the protocol text at its offsets', async () => {
  const { body } = await advisor.createProtocol(db, w.maintainer.actor, { title: 'Проверка цитат', text: PROTOCOL, method: 'rules' }, undefined, null);
  await assert.rejects(
    asUser(
      w.maintainer,
      `INSERT INTO protocol_candidates (organization_id, protocol_id, ord, quote_start, quote_end, quote, proposed_title, proposed_kind)
       VALUES ($1, $2, 99, 0, 10, 'Выдумано!!', 'Выдумано', 'idea')`,
      [w.acmeId, body.id],
    ),
    /нарушают ограничения/,
  );
});

test('a lead confirms the facts: the candidate becomes an ordinary meeting item, no XP, credit to who raised it', async () => {
  const { body } = await advisor.createProtocol(db, w.maintainer.actor, { title: 'Планёрка №2', text: PROTOCOL, method: 'rules' }, undefined, null);
  const p = await advisor.getProtocol(db, w.maintainer.actor, body.id);
  const k = p.candidates.find((x: { ord: number }) => x.ord === 2) as { id: string; quote: string };
  const input = {
    kind: 'problem' as const,
    title: 'Сканер у ворот №2 зависает на холоде',
    problem: k.quote,
    categoryId: f.categories.it,
    departmentId: f.departments.sklad,
    raisedBy: w.colleague.membershipId,
  };
  await assert.rejects(advisor.acceptCandidate(db, w.author.actor, body.id, k.id, input), codes('forbidden'));
  const r = await advisor.acceptCandidate(db, w.maintainer.actor, body.id, k.id, input, 'key-accept-1');
  const item = r.body.item;
  assert.equal(item.routed, true);
  const [idea] = await ownerQuery<{ source_channel: string; source_note: string; raised_by_membership_id: string }>(
    db,
    'SELECT source_channel, source_note, raised_by_membership_id FROM ideas WHERE id = $1',
    [item.id],
  );
  assert.equal(idea!.source_channel, 'meeting');
  assert.equal(idea!.source_note, 'Протокол «Планёрка №2», пункт 2');
  assert.equal(idea!.raised_by_membership_id, w.colleague.membershipId);
  const credit = await ownerQuery<{ kind: string }>(db, 'SELECT kind FROM contributions WHERE idea_id = $1 AND membership_id = $2', [item.id, w.colleague.membershipId]);
  assert.deepEqual(credit.map((c) => c.kind), ['issue_found']);
  assert.equal((await ownerQuery(db, 'SELECT 1 FROM xp_awards WHERE idea_id = $1', [item.id])).length, 0);
  // Replay returns the same item; a second decision on the candidate is refused.
  assert.equal((await advisor.acceptCandidate(db, w.maintainer.actor, body.id, k.id, input, 'key-accept-1')).body.item.number, item.number);
  await assert.rejects(advisor.acceptCandidate(db, w.maintainer.actor, body.id, k.id, input, 'key-accept-2'), codes('conflict'));
  await assert.rejects(advisor.dismissCandidate(db, w.maintainer.actor, body.id, k.id), codes('conflict'));
  const after = await advisor.getProtocol(db, w.maintainer.actor, body.id);
  const decided = after.candidates.find((x: { id: string }) => x.id === k.id) as { status: string; itemNumber: number; decidedBy: string };
  assert.equal(decided.status, 'accepted');
  assert.equal(decided.itemNumber, item.number);
  assert.equal(decided.decidedBy, 'Мария Ведущая');
  // Even the owner cannot rewrite the evidence or reopen the decision.
  await assert.rejects(ownerQuery(db, "UPDATE protocol_candidates SET quote = 'x' WHERE id = $1", [k.id]));
  await assert.rejects(ownerQuery(db, 'DELETE FROM protocol_candidates WHERE id = $1', [k.id]));
});

test('dismissing keeps the candidate as history', async () => {
  const { body } = await advisor.createProtocol(db, w.decider.actor, { title: 'Планёрка №3', text: PROTOCOL, method: 'rules' }, undefined, null);
  const p = await advisor.getProtocol(db, w.decider.actor, body.id);
  const k = p.candidates[0] as { id: string };
  await advisor.dismissCandidate(db, w.decider.actor, body.id, k.id, 'key-dismiss-1');
  const [row] = await ownerQuery<{ status: string; item_id: string | null }>(db, 'SELECT status, item_id FROM protocol_candidates WHERE id = $1', [k.id]);
  assert.deepEqual(row, { status: 'dismissed', item_id: null });
});

test('the questionnaire is private: the person and leads read it, colleagues do not', async () => {
  const saved = await advisor.saveMyProfile(db, w.colleague.actor, { skills: ['Принтеры', 'сканеры', 'принтеры'], preferences: 'Утренние смены', weeklyHours: 4 });
  assert.deepEqual(saved.skills, ['Принтеры', 'сканеры']);
  assert.equal((await advisor.getMyProfile(db, w.colleague.actor)).weeklyHours, 4);
  assert.equal((await asUser(w.author, 'SELECT 1 FROM employee_profiles')).rowCount, 0);
  assert.equal((await asUser(w.maintainer, 'SELECT 1 FROM employee_profiles')).rowCount, 1);
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM employee_profiles')).rowCount, 0);
  await assert.rejects(
    asUser(w.author, 'INSERT INTO employee_profiles (organization_id, membership_id, skills) VALUES ($1, $2, $3)', [w.acmeId, w.colleague.membershipId, ['подлог']]),
  );
  await assert.rejects(advisor.saveMyProfile(db, w.author.actor, { skills: [], weeklyHours: 80 } as never));
});

test('executors are suggested with reasons; a lead (not an originator) confirms, once', async () => {
  await advisor.saveMyProfile(db, w.admin.actor, { skills: ['Бухгалтерия'], weeklyHours: 10 });
  const n = (await submit(db, w.author, { title: 'Принтер этикеток у ворот', problem: 'Принтеры этикеток стоят далеко от ворот, сканеры не печатают', categoryId: f.categories.it, departmentId: f.departments.sklad })).body.item.number;
  await assert.rejects(advisor.suggestExecutors(db, w.colleague.actor, n), codes('forbidden'));
  const s = await advisor.suggestExecutors(db, w.maintainer.actor, n);
  assert.equal(s.method, 'Разбор по шаблону (без ИИ)');
  assert.deepEqual(s.suggestions.map((x) => x.name), ['Анна Коллега']);
  const a = s.suggestions[0]!;
  assert.deepEqual(a.matched.sort(), ['Принтеры', 'сканеры']);
  assert.ok(a.reasons.some((r) => r.includes('4 ч в неделю')));
  assert.ok(a.reasons.includes('Сейчас ничего не внедряет'));
  await assert.rejects(advisor.confirmExecutor(db, w.colleague.actor, n, { candidate: w.colleague.membershipId, reasons: [] }), codes('forbidden'));
  await advisor.confirmExecutor(db, w.maintainer.actor, n, { candidate: w.colleague.membershipId, reasons: a.reasons }, 'key-exec-1');
  await assert.rejects(advisor.confirmExecutor(db, w.decider.actor, n, { candidate: w.colleague.membershipId, reasons: [] }), codes('conflict'));
  const again = await advisor.suggestExecutors(db, w.decider.actor, n);
  assert.deepEqual(again.confirmed.map((x) => [x.name, x.confirmedBy]), [['Анна Коллега', 'Мария Ведущая']]);
  // Confirmation is a recommendation for the decision owner: it does not assign anyone by itself.
  const [idea] = await ownerQuery<{ implementer_membership_id: string | null }>(db, 'SELECT implementer_membership_id FROM ideas WHERE number = $1 AND organization_id = $2', [n, w.acmeId]);
  assert.equal(idea!.implementer_membership_id, null);
  await assert.rejects(ownerQuery(db, 'DELETE FROM executor_confirmations'));
  // The decision owner then names the implementer through the usual decision step.
  await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Совет за, исполнитель подтверждён', implementer: w.colleague.membershipId });
});

test('an originator never confirms the executor of their own item, even when they are a lead elsewhere', async () => {
  // Routing never makes the author the lead: the IT rule skips Мария, the department head leads.
  const n = (
    await submit(db, w.maintainer, { title: 'Свет на рампе', problem: 'На рампе №3 не хватает света вечером, принтеры этикеток не видно', categoryId: f.categories.it, departmentId: f.departments.sklad })
  ).body.item.number;
  await assert.rejects(advisor.suggestExecutors(db, w.maintainer.actor, n), codes('forbidden'));
  await assert.rejects(advisor.confirmExecutor(db, w.maintainer.actor, n, { candidate: w.colleague.membershipId, reasons: [] }), codes('forbidden'));
  const [idea] = await ownerQuery<{ id: string }>(db, 'SELECT id FROM ideas WHERE number = $1 AND organization_id = $2', [n, w.acmeId]);
  // The database refuses the same insert made directly (second line of defence).
  await assert.rejects(
    asUser(w.maintainer, 'INSERT INTO executor_confirmations (organization_id, idea_id, candidate_membership_id, confirmed_by_membership_id) VALUES ($1, $2, $3, $4)', [
      w.acmeId,
      idea!.id,
      w.colleague.membershipId,
      w.maintainer.membershipId,
    ]),
  );
  assert.equal((await advisor.suggestExecutors(db, f.head.actor, n)).canConfirm, true);
  await advisor.confirmExecutor(db, f.head.actor, n, { candidate: w.colleague.membershipId, reasons: [] });
});

test('local model: off by default, local only, invented quotes dropped', async () => {
  assert.equal(modelConfigFromEnv({}), null);
  assert.throws(() => modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'ollama', MODUS_ADVISOR_URL: 'https://api.example.com', MODUS_ADVISOR_MODEL: 'x' }), /не на этот компьютер/);
  // A cloud provider is refused unless the owner switches it on explicitly (ADR-0024; details in cloud-model.test.ts).
  assert.throws(() => modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'openai', MODUS_ADVISOR_MODEL: 'x' }), /MODUS_ADVISOR_ALLOW_REMOTE=true/);
  await assert.rejects(advisor.createProtocol(db, w.maintainer.actor, { title: 'Без модели', text: PROTOCOL, method: 'model' }, undefined, null), codes('conflict'));

  const cfg = modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'ollama', MODUS_ADVISOR_MODEL: 'test-model' }) as ModelConfig;
  const calls: string[] = [];
  const stub = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'test-model' }] });
    const req = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    assert.equal(req.messages[1]!.content, PROTOCOL);
    return Response.json({
      message: {
        content: JSON.stringify({
          items: [
            { quote: 'Руслан Исаев: сканер у ворот №2 зависает на холоде, вводим коды вручную.', title: 'Сканер зависает на холоде', kind: 'problem', raiser: 'Руслан Исаев' },
            { quote: 'Срочно закупить 40 сканеров', title: 'Выдумано моделью', kind: 'idea' },
          ],
        }),
      },
    });
  }) as typeof fetch;
  const st = await advisor.advisorStatus(cfg, stub);
  assert.deepEqual([st.model.configured, st.model.reachable], [true, true]);
  const r = await advisor.createProtocol(db, w.maintainer.actor, { title: 'Через модель', text: PROTOCOL, method: 'model' }, undefined, cfg, stub);
  assert.deepEqual([r.body.candidates, r.body.dropped], [1, 1]);
  assert.equal(calls[0], 'http://127.0.0.1:11434/api/tags');
  const p = await advisor.getProtocol(db, w.maintainer.actor, r.body.id);
  assert.deepEqual([p.method, p.model, p.candidates[0].title], ['model', 'test-model', 'Сканер зависает на холоде']);

  const down = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  assert.equal((await advisor.advisorStatus(cfg, down)).model.reachable, false);
  await assert.rejects(advisor.createProtocol(db, w.maintainer.actor, { title: 'Модель лежит', text: PROTOCOL, method: 'model' }, undefined, cfg, down), /не отвечает/);
});

test('HTTP: status says plainly that no model is connected; employees cannot parse protocols', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../../platform/http/app.ts');
  const { issueToken } = await import('../../platform/http/auth.ts');
  const SECRET = 'advisor-test-secret-'.padEnd(48, 'x');
  const server = createServer(createApp({ db, authSecret: SECRET }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/orgs/acme`;
  const call = (p: { userId: string }, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${issueToken(SECRET, p.userId)}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': `key-${Math.random().toString(36).slice(2)}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    const st = (await (await call(w.author, 'GET', '/advisor/status')).json()) as { model: { configured: boolean }; note: string };
    assert.equal(st.model.configured, false);
    assert.match(st.note, /не ИИ/);
    assert.equal((await call(w.author, 'POST', '/protocols', { title: 'Планёрка', text: PROTOCOL })).status, 403);
    const ok = await call(w.maintainer, 'POST', '/protocols', { title: 'Планёрка HTTP', text: PROTOCOL });
    assert.equal(ok.status, 201);
    assert.equal((await call(w.author, 'PUT', '/me/profile', { skills: ['Погрузчик'], weeklyHours: 2 })).status, 200);
    assert.deepEqual(((await (await call(w.author, 'GET', '/me/profile')).json()) as { skills: string[] }).skills, ['Погрузчик']);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
