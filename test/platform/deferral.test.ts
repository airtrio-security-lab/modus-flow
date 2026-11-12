import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../platform/db/pool.ts';
import { assessItem } from '../../platform/modules/assessment.ts';
import { defer, resume, DeferInput } from '../../platform/modules/deferral.ts';
import { getIdea } from '../../platform/modules/ideas.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { searchItems, SearchQuery } from '../../platform/modules/search.ts';
import { assignTitle, AssignTitleInput } from '../../platform/modules/titles.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Отложить решение» (0018) and «Оценка ИИ». Postponing belongs to the person who decides the item —
 * a title gives no right; the resolution deadline is paused and comes back on return. The AI
 * assessment answers only through a connected local model and never pretends otherwise.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let n: number;
const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const day = (plus: number) => new Date(Date.now() + plus * 86400_000).toISOString().slice(0, 10);
const due = async () => (await ownerQuery<{ d: Date }>(db, `SELECT resolution_due_at AS d FROM ideas WHERE number = ${n}`))[0]!.d.getTime();
const item = async (who = w.author) => (await getIdea(db, who.actor, n)) as unknown as { deferral: { until: string; reason: string; by: string | null } | null };

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  n = (await submit(db, w.author, { title: 'Терминал на приёмке печатает пустые этикетки', kind: 'problem', categoryId: f.categories.it })).body.item.number;
});
after(async () => drop());

test('only the decision owner of the item postpones it; a king\'s title or the admin role gives no right', async () => {
  const input = DeferInput.parse({ until: day(10), reason: 'Ждём поставку новых терминалов, решим после приёмки' });
  await assert.rejects(defer(db, w.author.actor, n, input), codes('forbidden'));
  await assert.rejects(defer(db, w.maintainer.actor, n, input), codes('forbidden'));
  await assert.rejects(defer(db, w.admin.actor, n, input), codes('forbidden'));
  const king = await person(db, w.acmeId, 'Король По Чину', ['employee', 'decision_owner'], 'Руководство');
  await assignTitle(db, w.admin.actor, king.membershipId, AssignTitleInput.parse({ rank: 'king' }));
  await assert.rejects(defer(db, king.actor, n, input), codes('forbidden'), 'the King\'s title and deciding other items do not let one postpone this item');
  assert.equal((await item()).deferral, null);
});

test('the date and the reason are required and sane', async () => {
  assert.throws(() => DeferInput.parse({ until: day(5), reason: 'мало' }));
  assert.throws(() => DeferInput.parse({ until: '20.11.2026', reason: 'Ждём поставку новых терминалов' }));
  const reason = 'Ждём поставку новых терминалов';
  await assert.rejects(defer(db, w.decider.actor, n, { until: day(0), reason }), codes('validation_failed'));
  await assert.rejects(defer(db, w.decider.actor, n, { until: day(-3), reason }), codes('validation_failed'));
  await assert.rejects(defer(db, w.decider.actor, n, { until: day(400), reason }), codes('validation_failed'));
});

test('postponing pauses the resolution deadline, tells the author why, and shows on the item and in the city', async () => {
  const before = await due();
  const stage = (await ownerQuery<{ stage: string }>(db, `SELECT stage FROM ideas WHERE number = ${n}`))[0]!.stage;
  const r = await defer(db, w.decider.actor, n, { until: day(10), reason: 'Ждём поставку новых терминалов, решим после приёмки' }, 'defer-key-000001');
  assert.equal(r.status, 201);
  const moved = (await due()) - before;
  assert.ok(moved > 10 * 86400_000 && moved <= 11 * 86400_000, `the deadline moved by the pause: ${moved / 86400_000} d`);
  // The same request again changes nothing; a second postponement on top is refused.
  await defer(db, w.decider.actor, n, { until: day(10), reason: 'Ждём поставку новых терминалов, решим после приёмки' }, 'defer-key-000001');
  assert.equal((await due()) - before, moved);
  await assert.rejects(defer(db, w.decider.actor, n, { until: day(20), reason: 'Ещё одна причина отложить решение' }), codes('conflict'));
  // The author reads the state and the reason.
  const seen = (await item()).deferral!;
  assert.deepEqual([seen.until, seen.reason], [day(10), 'Ждём поставку новых терминалов, решим после приёмки']);
  const inbox = await listInbox(db, w.author.actor);
  assert.ok(inbox.some((x) => x.event === 'idea_deferred'), 'the author is told');
  assert.equal((await listInbox(db, w.decider.actor)).some((x) => x.event === 'idea_deferred'), false, 'the person who postponed is not');
  // Nothing else changed: the stage, the status; and the paused item is not overdue.
  assert.equal((await ownerQuery<{ stage: string }>(db, `SELECT stage FROM ideas WHERE number = ${n}`))[0]!.stage, stage);
  const overdue = (await searchItems(db, w.admin.actor, SearchQuery.parse({ overdue: 'true' }))) as { number: number }[];
  assert.equal(overdue.some((i) => i.number === n), false);
  const k = await kingdom(db, w.author.actor);
  assert.equal(k.envoys.find((e) => e.number === n)!.deferredUntil, day(10));
  assert.equal(await ownerQuery<{ c: string }>(db, `SELECT count(*) AS c FROM audit_events WHERE action = 'idea.deferred'`).then((x) => Number(x[0]!.c)), 1);
  assert.equal(await ownerQuery<{ c: string }>(db, `SELECT count(*) AS c FROM xp_awards`).then((x) => Number(x[0]!.c)), 0);
});

test('returning to work gives the unused pause back to the deadline; only the decision owner returns it', async () => {
  const paused = await due();
  await assert.rejects(resume(db, w.author.actor, n), codes('forbidden'));
  await resume(db, w.decider.actor, n);
  const back = paused - (await due());
  assert.ok(back > 9.9 * 86400_000 && back <= 11 * 86400_000, `the unused pause is returned: ${back / 86400_000} d`);
  assert.equal((await item()).deferral, null);
  await assert.rejects(resume(db, w.decider.actor, n), codes('conflict'));
  // Postponing again after a return works.
  await defer(db, w.decider.actor, n, { until: day(3), reason: 'Поставка сдвинулась, ждём до пятницы' });
  assert.equal((await item()).deferral!.until, day(3));
  await resume(db, w.decider.actor, n);
});

test('a decided item cannot be postponed', async () => {
  const wf = await import('../../platform/modules/workflow.ts');
  const m = (await submit(db, w.author, { title: 'Не хватает стеллажей в зоне отгрузки', kind: 'problem', categoryId: f.categories.it })).body.item.number;
  await wf.addReview(db, w.maintainer.actor, m, { kind: 'comment', body: 'Посмотрели, стеллажи заказаны раньше' });
  await wf.decide(db, w.decider.actor, m, { outcome: 'close', rationale: 'Стеллажи уже заказаны по другой заявке, отдельное решение не нужно' });
  await assert.rejects(defer(db, w.decider.actor, m, { until: day(5), reason: 'Попытка отложить закрытое обращение' }), codes('conflict', 'forbidden'));
});

test('AI assessment: without a model it says «не подключён»; with a model it shows the model\'s answer and rejects junk', async () => {
  const none = await assessItem(db, w.author.actor, n, null);
  assert.equal(none.available, false);
  assert.match(none.note, /ИИ не подключён/);
  const model = { provider: 'ollama' as const, url: 'http://127.0.0.1:11434', model: 'test-model' };
  let asked = '';
  const answer = (content: string) =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      asked = String(init?.body ?? '');
      return new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const good = await assessItem(db, w.author.actor, n, model, answer(JSON.stringify({ verdict: 'doubts', summary: 'Проблема описана, но решение не предложено: нужны данные о частоте сбоев.', strengths: ['Понятно, где возникает сбой'], risks: ['Причина не установлена'], questions: ['Как часто печатаются пустые этикетки?'] })));
  assert.ok(good.available && good.ok);
  if (good.available && good.ok) {
    assert.deepEqual([good.model, good.subject, good.assessment.verdict], ['локальная модель test-model', 'proposal', 'doubts']);
    assert.match(good.note, /не покидал этот компьютер/);
    assert.equal(good.assessment.questions.length, 1);
  }
  assert.match(asked, /Терминал на приёмке печатает пустые этикетки/, 'the model is given the item itself');
  for (const junk of ['не json', '{"verdict":"отлично"}', '{}']) {
    const bad = await assessItem(db, w.author.actor, n, model, answer(junk));
    assert.ok(bad.available && !bad.ok, `junk is not shown as an assessment: ${junk}`);
  }
  const down = await assessItem(db, w.author.actor, n, model, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
  assert.ok(down.available && !down.ok && /не отвечает/.test(down.note));
  // An item the reader cannot open is not assessed for them.
  await assert.rejects(assessItem(db, w.outsider.actor, n, model, answer('{}')), codes('not_found'));
});
