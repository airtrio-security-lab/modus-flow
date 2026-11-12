import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../platform/db/pool.ts';
import { withTx } from '../../platform/db/pool.ts';
import { createDraft, deleteDraft, getDraft, listDrafts, publishDraft, saveVersion } from '../../platform/modules/lab.ts';
import { getIdea, listIdeas } from '../../platform/modules/ideas.ts';
import { listInbox } from '../../platform/modules/notifications.ts';
import { hashRequest, idempotent } from '../../platform/modules/idempotency.ts';
import { freshDatabase, fullDraft, ownerQuery, world } from './support/db.ts';

let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
});
after(async () => drop());

const PRIVATE = /ЛИЧНОЕ/;

test('drafts are private to their owner', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  assert.equal(d.state, 'private');
  assert.equal(d.version, 1);
  await assert.rejects(getDraft(db, w.colleague.userId, d.id), { code: 'not_found' });
  await assert.rejects(getDraft(db, w.admin.userId, d.id), { code: 'not_found' });
  assert.equal((await listDrafts(db, w.maintainer.userId)).length, 0);
  await assert.rejects(deleteDraft(db, w.colleague.userId, d.id), { code: 'not_found' });
});

test('versions are append-only and protected against stale writes', async () => {
  const d = await createDraft(db, w.author.userId, { kind: 'problem', title: 'Очередь на кассе', content: { observation: 'Длинная очередь' } });
  const v2 = await saveVersion(db, w.author.userId, d.id, { baseVersion: 1, title: 'Очередь на кассе', content: { observation: 'Очередь 15 минут' } });
  assert.equal(v2.version, 2);
  await assert.rejects(
    saveVersion(db, w.author.userId, d.id, { baseVersion: 1, title: 'Очередь', content: {} }),
    { code: 'conflict' },
    'second device with an old base version must not overwrite',
  );
  const full = await getDraft(db, w.author.userId, d.id);
  assert.deepEqual(full.versions.map((v) => v.version), [1, 2]);
});

test('publication creates idea, revision, authorship and audit atomically — without private steps', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  const r = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  assert.equal(r.status, 201);
  const idea = await getIdea(db, w.colleague.actor, r.body.idea.number);
  assert.equal(idea.stage, 'published');
  assert.equal(idea.author?.name, 'Кирилл Демо');
  assert.equal(idea.revisions.length, 1);
  assert.doesNotMatch(JSON.stringify(idea), PRIVATE, 'cause/evidence/risks/notes never leave the Lab');

  const [contrib] = await ownerQuery<{ kind: string; membership_id: string }>(db, 'SELECT kind, membership_id FROM contributions WHERE idea_id = $1', [idea.id]);
  assert.equal(contrib?.kind, 'authorship');
  assert.equal(contrib?.membership_id, w.author.membershipId);

  const orgAudit = await ownerQuery<{ data: unknown }>(db, 'SELECT data FROM audit_events WHERE organization_id IS NOT NULL');
  assert.doesNotMatch(JSON.stringify(orgAudit), PRIVATE);
  assert.doesNotMatch(JSON.stringify(orgAudit), new RegExp(d.id), 'org audit does not reveal the private draft id');

  const after = await getDraft(db, w.author.userId, d.id);
  assert.equal(after.state, 'published');
  await assert.rejects(saveVersion(db, w.author.userId, d.id, { baseVersion: 1, title: 'Изменено', content: {} }), { code: 'conflict' });
});

test('publication requires observation and proposal', async () => {
  const d = await createDraft(db, w.author.userId, { kind: 'idea', title: 'Сырая мысль', content: { notes: 'потом' } });
  await assert.rejects(publishDraft(db, w.author.userId, d.id, { organization: 'acme' }), { code: 'validation_failed' });
  assert.equal((await getDraft(db, w.author.userId, d.id)).state, 'private');
});

test('publishing into an organization you do not belong to fails and changes nothing', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  await assert.rejects(publishDraft(db, w.author.userId, d.id, { organization: 'beta' }), { code: 'not_found' });
  await assert.rejects(publishDraft(db, w.author.userId, d.id, { organization: 'no-such-org' }), { code: 'not_found' });
  assert.equal((await getDraft(db, w.author.userId, d.id)).state, 'private');
  assert.equal((await listIdeas(db, w.outsider.actor)).length, 0);
});

test('only the owner can publish a draft', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  await assert.rejects(publishDraft(db, w.colleague.userId, d.id, { organization: 'acme' }), { code: 'not_found' });
});

test('idempotent publish: same key replays, different payload is rejected', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  const key = 'publish-key-0001';
  const first = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' }, key);
  const again = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' }, key);
  assert.equal(first.replayed, false);
  assert.equal(again.replayed, true);
  assert.deepEqual(again.body, first.body);
  const [{ n }] = (await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM ideas WHERE id = $1', [first.body.idea.id])) as [{ n: number }];
  assert.equal(n, 1);
});

test('concurrent publication of one draft creates exactly one idea', async () => {
  const d = await createDraft(db, w.author.userId, fullDraft);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => publishDraft(db, w.author.userId, d.id, { organization: 'acme' }, `race-key-000${i}`)),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.ok(failed.every((f) => (f.reason as { code?: string }).code === 'conflict'));
});

test('idea numbers are sequential per organization', async () => {
  const before = (await listIdeas(db, w.author.actor)).map((i) => i.number);
  const d = await createDraft(db, w.author.userId, fullDraft);
  const r = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  assert.equal(r.body.idea.number, Math.max(0, ...before) + 1);
});

test('new idea notifies maintainers and decision owners only — not colleagues, not the author', async () => {
  const d = await createDraft(db, w.author.userId, { ...fullDraft, title: 'Уведомление для триажа' });
  const r = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  const forIdea = async (p: typeof w.author) => (await listInbox(db, p.actor)).filter((n) => n.ideaNumber === r.body.idea.number);
  const m = await forIdea(w.maintainer);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.message, 'Кирилл Демо предлагает на обсуждение новую идею «Уведомление для триажа»');
  assert.equal((await forIdea(w.decider)).length, 1);
  assert.equal((await forIdea(w.colleague)).length, 0);
  assert.equal((await forIdea(w.author)).length, 0);
  assert.equal((await forIdea(w.admin)).length, 0);
});

test('muted subscriptions are honoured', async () => {
  await withTx(db, w.decider.actor, (c) =>
    c.query(`INSERT INTO notification_subscriptions (organization_id, membership_id, event_type, enabled) VALUES ($1, $2, 'idea_published', false)`, [
      w.acmeId,
      w.decider.membershipId,
    ]),
  );
  const d = await createDraft(db, w.author.userId, { ...fullDraft, title: 'Тихая идея' });
  const r = await publishDraft(db, w.author.userId, d.id, { organization: 'acme' });
  const inbox = (await listInbox(db, w.decider.actor)).filter((n) => n.ideaNumber === r.body.idea.number);
  assert.equal(inbox.length, 0);
});

test('organizations are isolated at the service level', async () => {
  const ideas = await listIdeas(db, w.outsider.actor);
  assert.equal(ideas.length, 0);
  await assert.rejects(getIdea(db, w.outsider.actor, 1), { code: 'not_found' });
});

test('idempotency: a reused key with a different request is rejected and runs nothing', async () => {
  let runs = 0;
  const op = async () => {
    runs++;
    return { status: 201, body: { ok: true } };
  };
  const who = { userId: w.author.userId };
  await withTx(db, who, (c) => idempotent(c, w.author.userId, 'test.scope', 'same-key-0001', hashRequest({ a: 1 }), op));
  await assert.rejects(
    withTx(db, who, (c) => idempotent(c, w.author.userId, 'test.scope', 'same-key-0001', hashRequest({ a: 2 }), op)),
    { code: 'idempotency_mismatch' },
  );
  await assert.rejects(
    withTx(db, who, (c) => idempotent(c, w.author.userId, 'test.scope', 'bad key!', hashRequest({}), op)),
    { code: 'validation_failed' },
  );
  assert.equal(runs, 1);
});
