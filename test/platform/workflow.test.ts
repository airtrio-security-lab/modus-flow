import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../platform/db/pool.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { getIdea, listIdeas } from '../../platform/modules/ideas.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { createDraft, publishDraft } from '../../platform/modules/lab.ts';
import { freshDatabase, fullDraft, ownerQuery, person, world } from './support/db.ts';
import { ideaInReview, ideaInVerification, publishIdea, revisionText } from './support/flow.ts';

let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

const events = async (p: typeof w.author, n: number) =>
  (await listInbox(db, p.actor)).filter((x) => x.ideaNumber === n).map((x) => x.event).sort();

// ---------------------------------------------------------------------------
// The vertical slice
// ---------------------------------------------------------------------------
test('scenario: review → change request → objection → revision → verification (+/- evidence) → merge', async () => {
  const n = await publishIdea(db, w, 'Слоты разгрузки');

  const assigned = await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  assert.equal(assigned.body.stage, 'review');

  const cr = await wf.addReview(db, w.maintainer.actor, n, {
    kind: 'request_changes',
    body: 'Не учтены опоздания поставщиков: слоты сорвутся в первый же день',
  });
  assert.equal(cr.body.stage, 'development');

  const objection = await wf.addReview(db, w.author.actor, n, {
    kind: 'objection',
    parentReviewId: cr.body.id,
    body: 'Опоздания есть, но резервный слот это покрывает — добавлю его явно',
  });
  assert.equal(objection.body.kind, 'objection');
  await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'На рампе №2 удобно проверить' });

  const rev = await wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText, rationale: 'Добавлен резервный слот' });
  assert.deepEqual(rev.body, { revision: 2, stage: 'review' });

  await wf.resolveReview(db, w.maintainer.actor, n, cr.body.id, { outcome: 'resolved', note: 'Резервный слот снимает замечание' });

  const v = await wf.startVerification(db, w.maintainer.actor, n, {
    plan: 'Две недели на рампе №2, замер времени ожидания',
    successCriteria: 'Среднее ожидание меньше 40 минут',
    owner: w.colleague.membershipId,
  });
  assert.equal(v.body.revision, 2, 'verification is pinned to the revision it tests');
  const ev = (kind: wf.EvidenceKind, body: string, extra = {}) =>
    wf.recordEvidence(db, w.colleague.actor, n, v.body.id, { kind, body, ...extra });
  await ev('baseline', 'До пилота', { metric: 'ожидание', value: 118, unit: 'мин' });
  await ev('result', 'После двух недель', { metric: 'ожидание', value: 34, unit: 'мин' });
  await ev('positive_observation', 'Водители перестали скапливаться у ворот');
  await ev('negative_observation', 'В пятницу два слота пропали из-за сбоя записи');

  const concluded = await wf.concludeVerification(db, w.maintainer.actor, n, v.body.id, {
    outcome: 'positive',
    conclusion: 'Критерий достигнут; пятничный сбой записи нужно устранить до масштабирования',
  });
  assert.equal(concluded.body.stage, 'decision');

  const d = await wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Внедряем на всех рампах с исправлением записи' });
  assert.equal(d.body.stage, 'adoption');
  assert.deepEqual(
    (d.body.verificationSummary as { outcome: string; negativeEvidence: number }[]).map((s) => [s.outcome, s.negativeEvidence]),
    [['positive', 1]],
    'the decision permanently records that negative evidence existed',
  );

  const full = await getIdea(db, w.colleague.actor, n);
  assert.equal(full.stage, 'adoption');
  assert.deepEqual(
    full.revisions.map((r: { number: number; status: string; author: string }) => [r.number, r.status, r.author]),
    [
      [1, 'superseded', 'Кирилл Демо'],
      [2, 'current', 'Кирилл Демо'],
    ],
    'both versions kept; authorship unchanged',
  );
  assert.deepEqual(
    full.reviews.map((r: { kind: string; state: string }) => [r.kind, r.state]),
    [
      ['request_changes', 'resolved'],
      ['objection', 'open'],
      ['comment', 'open'],
    ],
  );
  const kinds = full.verifications[0].evidence.map((e: { kind: string }) => e.kind);
  assert.deepEqual(kinds, ['baseline', 'result', 'positive_observation', 'negative_observation']);
  assert.deepEqual(
    full.contributions.map((c: { kind: string; member: string }) => [c.kind, c.member]),
    [
      ['authorship', 'Кирилл Демо'],
      ['review', 'Мария Ведущая'],
      ['verification', 'Анна Коллега'],
    ],
  );

  assert.deepEqual(await events(w.author, n), ['changes_requested', 'comment_added', 'comment_added', 'idea_merged', 'verification_completed', 'verification_started']);
  assert.deepEqual(await events(w.maintainer, n), ['comment_added', 'idea_merged', 'idea_published', 'objection_raised', 'revision_submitted']);
  assert.ok((await events(w.decider, n)).includes('verification_completed'));
});

test('scenario: negative verification → reject; the negative result is credited and kept', async () => {
  const { n, v } = await ideaInVerification(db, w, 'Ночная приёмка');
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'result', body: 'Ожидание выросло', metric: 'ожидание', value: 140, unit: 'мин' });
  await wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'negative_observation', body: 'Ночная смена не справилась' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'negative', conclusion: 'Гипотеза не подтвердилась, ожидание выросло' });
  const d = await wf.decide(db, w.decider.actor, n, { outcome: 'reject', rationale: 'Пилот показал ухудшение; оставляем текущий порядок' });
  assert.equal(d.body.stage, 'closed');

  const full = await getIdea(db, w.author.actor, n);
  assert.equal(full.verifications[0].outcome, 'negative');
  assert.equal(full.verifications[0].evidence.length, 2);
  assert.ok(full.contributions.some((c: { kind: string; member: string }) => c.kind === 'negative_result' && c.member === 'Анна Коллега'));
  assert.ok(full.contributions.some((c: { kind: string }) => c.kind === 'authorship'), 'rejection does not erase authorship');
  await assert.rejects(wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'ещё мысль' }), { code: 'forbidden' });
});

test('scenario: the author objects, the maintainer withdraws the request, the idea returns to review', async () => {
  const n = await ideaInReview(db, w);
  const cr = await wf.addReview(db, w.maintainer.actor, n, { kind: 'request_changes', body: 'Нужна оценка стоимости' });
  await wf.addReview(db, w.author.actor, n, { kind: 'objection', parentReviewId: cr.body.id, body: 'Стоимость нулевая: используем существующую систему записи' });
  const r = await wf.resolveReview(db, w.maintainer.actor, n, cr.body.id, { outcome: 'withdrawn', note: 'Возражение принято' });
  assert.equal(r.body.stage, 'review');
});

// ---------------------------------------------------------------------------
// Independent powers and authorship
// ---------------------------------------------------------------------------
test('only the review lead requests changes; the author cannot resolve them', async () => {
  const n = await ideaInReview(db, w);
  await assert.rejects(wf.addReview(db, w.colleague.actor, n, { kind: 'request_changes', body: 'x' }), { code: 'forbidden' });
  await assert.rejects(wf.addReview(db, w.admin.actor, n, { kind: 'request_changes', body: 'x' }), { code: 'forbidden' });
  const cr = await wf.addReview(db, w.maintainer.actor, n, { kind: 'request_changes', body: 'Уточните смены' });
  await assert.rejects(wf.resolveReview(db, w.author.actor, n, cr.body.id, { outcome: 'resolved', note: 'сам закрыл' }), { code: 'forbidden' });
});

test('objections: only the author, only to a change request', async () => {
  const n = await ideaInReview(db, w);
  const cr = await wf.addReview(db, w.maintainer.actor, n, { kind: 'request_changes', body: 'Уточните смены' });
  const c = await wf.addReview(db, w.colleague.actor, n, { kind: 'comment', body: 'мнение' });
  await assert.rejects(wf.addReview(db, w.colleague.actor, n, { kind: 'objection', parentReviewId: cr.body.id, body: 'не согласен' }), { code: 'forbidden' });
  await assert.rejects(wf.addReview(db, w.author.actor, n, { kind: 'objection', parentReviewId: c.body.id, body: 'не согласен' }), { code: 'validation_failed' });
});

test('nobody but the author edits the text; others suggest with their own authorship', async () => {
  const n = await ideaInReview(db, w);
  await assert.rejects(wf.revise(db, w.maintainer.actor, n, { baseRevision: 1, ...revisionText }), { code: 'forbidden' });
  await assert.rejects(wf.revise(db, w.decider.actor, n, { baseRevision: 1, ...revisionText }), { code: 'forbidden' });

  const s = await wf.suggest(db, w.colleague.actor, n, { baseRevision: 1, ...revisionText, rationale: 'Предлагаю добавить резервный слот' });
  await assert.rejects(wf.decideSuggestion(db, w.maintainer.actor, n, s.body.revision, { accept: true }), { code: 'forbidden' });
  await wf.decideSuggestion(db, w.author.actor, n, s.body.revision, { accept: true });

  const full = await getIdea(db, w.maintainer.actor, n);
  const current = full.revisions.find((r: { status: string }) => r.status === 'current');
  assert.equal(current.author, 'Анна Коллега', 'an accepted suggestion keeps its author');
  assert.equal(current.origin, 'suggestion');
  assert.ok(full.contributions.some((c: { kind: string; member: string }) => c.kind === 'co_authorship' && c.member === 'Анна Коллега'));
  await assert.rejects(wf.suggest(db, w.author.actor, n, { baseRevision: 2, ...revisionText, rationale: 'сам себе' }), { code: 'forbidden' });
});

test('stale suggestions and stale revisions are rejected, not merged silently', async () => {
  const n = await ideaInReview(db, w);
  const s = await wf.suggest(db, w.colleague.actor, n, { baseRevision: 1, ...revisionText, rationale: 'Альтернатива с резервом' });
  await wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText, title: 'Своя версия автора' });
  await assert.rejects(wf.decideSuggestion(db, w.author.actor, n, s.body.revision, { accept: true }), { code: 'conflict' });
  await assert.rejects(wf.revise(db, w.author.actor, n, { baseRevision: 1, ...revisionText }), { code: 'conflict' });
  await wf.decideSuggestion(db, w.author.actor, n, s.body.revision, { accept: false, note: 'Устарело' });
  const declined = (await getIdea(db, w.author.actor, n)).revisions.find((r: { number: number }) => r.number === s.body.revision);
  assert.equal(declined.status, 'declined', 'declined suggestions stay in history');
});

test('assignment: only org leads who are not the author; assignees must hold the role', async () => {
  const n = await publishIdea(db, w);
  await assert.rejects(wf.assign(db, w.author.actor, n, { maintainer: w.maintainer.membershipId }), { code: 'forbidden' });
  await assert.rejects(wf.assign(db, w.colleague.actor, n, { maintainer: w.maintainer.membershipId }), { code: 'forbidden' });
  await assert.rejects(wf.assign(db, w.maintainer.actor, n, { decisionOwner: w.colleague.membershipId }), { code: 'validation_failed' });
  await assert.rejects(wf.assign(db, w.maintainer.actor, n, { maintainer: w.author.membershipId }), { code: 'validation_failed' });

  const lead = await person(db, w.acmeId, 'Лид Автор', ['employee', 'maintainer', 'decision_owner'], 'Склад');
  const d = await createDraft(db, lead.userId, fullDraft);
  const own = (await publishDraft(db, lead.userId, d.id, { organization: 'acme' })).body.idea.number;
  await assert.rejects(wf.assign(db, lead.actor, own, { maintainer: lead.membershipId }), { code: 'forbidden' }, 'a lead cannot assign their own idea');
});

test('decisions: only the assigned decision owner; never by the author; never twice', async () => {
  const n = await ideaInReview(db, w);
  await assert.rejects(wf.decide(db, w.maintainer.actor, n, { outcome: 'merge', rationale: 'Ведущий решил сам' }), { code: 'forbidden' });
  await assert.rejects(wf.decide(db, w.author.actor, n, { outcome: 'merge', rationale: 'Автор решил сам' }), { code: 'forbidden' });
  await wf.decide(db, w.decider.actor, n, { outcome: 'close', rationale: 'Дублирует идею, уже внедрённую' });
  await assert.rejects(wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Передумал после закрытия' }), { code: 'forbidden' });
});

test('merge is gated: no open change requests, no unfinished verification', async () => {
  const n = await ideaInReview(db, w);
  const cr = await wf.addReview(db, w.maintainer.actor, n, { kind: 'request_changes', body: 'Добавьте замер' });
  await wf.resolveReview(db, w.maintainer.actor, n, cr.body.id, { outcome: 'withdrawn', note: 'Замер будет в пилоте' });
  const cr2 = await wf.addReview(db, w.decider.actor, n, { kind: 'request_changes', body: 'Не хватает оценки рисков' });
  await assert.rejects(wf.decide(db, w.decider.actor, n, { outcome: 'merge', rationale: 'Внедряем' }), { code: 'conflict' });
  void cr2;

  const { n: n2 } = await ideaInVerification(db, w);
  await assert.rejects(wf.decide(db, w.decider.actor, n2, { outcome: 'merge', rationale: 'Не дожидаясь пилота' }), { code: 'conflict' });
});

test('verification start is gated by automated checks', async () => {
  const d = await createDraft(db, w.author.userId, { kind: 'idea', title: 'Без критериев', content: { observation: fullDraft.content.observation, proposal: fullDraft.content.proposal } });
  const n = (await publishDraft(db, w.author.userId, d.id, { organization: 'acme' })).body.idea.number;
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  await assert.rejects(
    wf.startVerification(db, w.maintainer.actor, n, { plan: 'Пилот на две недели', successCriteria: 'Ожидание меньше 40 минут', owner: w.colleague.membershipId }),
    (e: { code?: string; details?: { failing: { id: string }[] } }) => e.code === 'checks_failed' && e.details!.failing.some((f) => f.id === 'success_criteria'),
  );
  await assert.rejects(
    wf.startVerification(db, w.author.actor, n, { plan: 'Пилот на две недели', successCriteria: 'Ожидание меньше 40 минут', owner: w.author.membershipId }),
    { code: 'forbidden' },
  );
});

test('conclusions need supporting evidence and are final; evidence only while running', async () => {
  const { n, v } = await ideaInVerification(db, w);
  await assert.rejects(wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Всё хорошо, поверьте' }), { code: 'validation_failed' });
  await assert.rejects(wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'negative', conclusion: 'Всё плохо, поверьте' }), { code: 'validation_failed' });
  await assert.rejects(wf.recordEvidence(db, w.author.actor, n, v, { kind: 'positive_observation', body: 'Автор доволен' }), { code: 'forbidden' });
  await assert.rejects(wf.concludeVerification(db, w.colleague.actor, n, v, { outcome: 'inconclusive', conclusion: 'Владелец проверки сам закрыл' }), { code: 'forbidden' });
  await wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'inconclusive', conclusion: 'Данных недостаточно, сезон нетипичный' });
  await assert.rejects(wf.recordEvidence(db, w.colleague.actor, n, v, { kind: 'positive_observation', body: 'Задним числом' }), { code: 'conflict' });
  await assert.rejects(wf.concludeVerification(db, w.maintainer.actor, n, v, { outcome: 'positive', conclusion: 'Переписываю вывод' }), { code: 'conflict' });
});

test('idempotent workflow steps: a retried request creates one record', async () => {
  const n = await ideaInReview(db, w);
  const input = { kind: 'comment' as const, body: 'Повтор запроса из-за плохой сети' };
  const a = await wf.addReview(db, w.colleague.actor, n, input, 'retry-review-0001');
  const b = await wf.addReview(db, w.colleague.actor, n, input, 'retry-review-0001');
  assert.equal(b.replayed, true);
  assert.equal(b.body.id, a.body.id);
  const rows = await ownerQuery(db, 'SELECT 1 FROM reviews WHERE body = $1', [input.body]);
  assert.equal(rows.length, 1);
  await assert.rejects(wf.addReview(db, w.colleague.actor, n, { ...input, body: 'другое' }, 'retry-review-0001'), { code: 'idempotency_mismatch' });
});

// ---------------------------------------------------------------------------
// Invited independent reviewer (owner decision for small teams)
// ---------------------------------------------------------------------------
test('guest decision owner: sees only assigned ideas, can decide them, has no other powers', async () => {
  const guest = await person(db, w.acmeId, 'Приглашённый Эксперт', ['decision_owner'], 'Внешний', 'guest');
  const other = await publishIdea(db, w, 'Чужая идея');
  const n = await publishIdea(db, w, 'Для гостя');

  assert.equal((await listIdeas(db, guest.actor)).length, 0, 'nothing visible before assignment');
  await assert.rejects(getIdea(db, guest.actor, n), { code: 'not_found' });
  assert.equal((await events(guest, n)).length, 0, 'guests are not part of triage');

  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: guest.membershipId });
  assert.deepEqual((await listIdeas(db, guest.actor)).map((i) => i.number), [n]);
  await assert.rejects(getIdea(db, guest.actor, other), { code: 'not_found' });
  await assert.rejects(wf.assign(db, guest.actor, n, { maintainer: w.maintainer.membershipId }), { code: 'forbidden' });

  const d = await wf.decide(db, guest.actor, n, { outcome: 'merge', rationale: 'Независимая оценка: внедрять' });
  assert.equal(d.body.stage, 'adoption');
});

test('guests cannot publish into the organization', async () => {
  const guest = await person(db, w.acmeId, 'Гость Публикатор', ['maintainer'], 'Внешний', 'guest');
  const d = await createDraft(db, guest.userId, fullDraft);
  await assert.rejects(publishDraft(db, guest.userId, d.id, { organization: 'acme' }), { code: 'forbidden' });
});

test('a guest membership cannot carry employee or admin roles', async () => {
  await assert.rejects(person(db, w.acmeId, 'Гость Админ', ['org_admin'], 'Внешний', 'guest'), { code: 'validation_failed' });
});
