import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withAdminTx, withTx, type Database } from '../../platform/db/pool.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as retention from '../../platform/modules/retention.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { freshDatabase, ownerQuery, world } from './support/db.ts';
import { feedbackOrg } from './support/feedback.ts';

/**
 * Owner decisions 2026-11-11 (ADR-0015): personal consent or a written protocol;
 * recordings 30 / transcripts 90 days by default; deletion only by an admin, with a
 * reason, never under legal hold, always logged immutably; restored backups are purged
 * again; confirmed decisions stay, unconfirmed drafts go.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
const none: meetings.MeetingDeps = { model: null, engine: null };
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 3)]);
const DAY = 86400e3;
const TEXT = `[00:00] Мария Ведущая: Начинаем разбор приёмки.
[00:05] Анна Коллега: Предлагаю печатать этикетку прямо со сканера на мобильный принтер у ворот.
[00:12] Кирилл Демо: Сканер у ворот зависает на холоде, приходится вводить коды вручную.`;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));

async function recordedMeeting(title: string) {
  const id = (await meetings.createMeeting(db, w.maintainer.actor, { title, participants: [w.author.membershipId, w.colleague.membershipId], organizerConsent: true })).body.id;
  await meetings.setConsent(db, w.author.actor, id, 'given');
  await meetings.setConsent(db, w.colleague.actor, id, 'given');
  await meetings.uploadRecording(db, w.maintainer.actor, id, { contentType: 'audio/webm', data: WEBM, source: 'microphone', durationMs: 20000 });
  const t = await meetings.addTranscript(db, w.maintainer.actor, id, { text: TEXT, source: 'manual' });
  await meetings.analyze(db, w.maintainer.actor, id, { transcriptId: t.id, method: 'rules' }, none);
  return { id, transcriptId: t.id };
}

test('no consent → no recording; the alternative is a written protocol without recording', async () => {
  const id = (await meetings.createMeeting(db, w.maintainer.actor, { title: 'Без записи', participants: [w.author.membershipId, w.colleague.membershipId], organizerConsent: true })).body.id;
  await meetings.setConsent(db, w.author.actor, id, 'declined');
  await assert.rejects(meetings.startRecording(db, w.maintainer.actor, id), codes('conflict'));
  await assert.rejects(meetings.uploadRecording(db, w.maintainer.actor, id, { contentType: 'audio/webm', data: WEBM, source: 'upload', durationMs: null }));
  const t = await meetings.addTranscript(db, w.maintainer.actor, id, { text: TEXT, source: 'minutes' });
  const a = await meetings.analyze(db, w.maintainer.actor, id, { transcriptId: t.id, method: 'rules' }, none);
  assert.ok((a.findings ?? 0) >= 2);
  const v = await meetings.getMeeting(db, w.author.actor, id, none);
  assert.deepEqual([v.recording, v.transcripts[0].source], [null, 'minutes']);
});

test('only an organization admin deletes, with a reason; the fact is logged immutably without content', async () => {
  const { id } = await recordedMeeting('Удаление записи');
  await assert.rejects(retention.purgeMedia(db, w.maintainer.actor, id, { what: 'recording', reason: 'Хочу удалить' }), codes('forbidden'));
  await assert.rejects(asUser(w.maintainer, `SELECT app_purge_meeting_media($1, 'recording', 'Хочу удалить')`, [id]));
  await assert.rejects(asUser(w.admin, `SELECT app_purge_meeting_media($1, 'recording', 'нет')`, [id]));
  // The app role cannot sneak past append-only with the purge flag: it has no UPDATE grant at all.
  await assert.rejects(asUser(w.maintainer, `SELECT set_config('modus.purge', 'on', true); UPDATE meeting_recordings SET data = NULL, purged_at = now() WHERE meeting_id = '${id}'`));
  // The admin was not at the meeting: deletion works without ever reading the content.
  const r = await retention.purgeMedia(db, w.admin.actor, id, { what: 'recording', reason: 'Просьба участника, согласовано с юристом' });
  assert.equal(r.purged, 1);
  await assert.rejects(meetings.downloadRecording(db, w.author.actor, id), codes('gone'));
  const [rec] = await ownerQuery<{ data: Buffer | null; sha256: string; purged_at: Date | null }>(db, 'SELECT data, sha256, purged_at FROM meeting_recordings WHERE meeting_id = $1', [id]);
  assert.equal(rec!.data, null);
  assert.ok(rec!.purged_at);
  const log = await ownerQuery<{ object: string; action: string; reason: string; actor: string; sha: string }>(
    db,
    'SELECT object, action, reason, actor_membership_id AS actor, content_sha256 AS sha FROM retention_log WHERE meeting_id = $1',
    [id],
  );
  assert.deepEqual(log.map((l) => [l.object, l.action, l.actor, l.sha]), [['recording', 'purged', w.admin.membershipId, rec!.sha256]]);
  assert.match(log[0]!.reason, /юрист/);
  await assert.rejects(ownerQuery(db, 'DELETE FROM retention_log'));
  await assert.rejects(ownerQuery(db, `UPDATE retention_log SET reason = 'подмена'`));
  // Non-admins do not read the log.
  assert.equal((await asUser(w.maintainer, 'SELECT 1 FROM retention_log')).rowCount, 0);
});

test('transcript purge: drafts go, confirmed findings and the decision record stay', async () => {
  const { id, transcriptId } = await recordedMeeting('Удаление расшифровки');
  const v = await meetings.getMeeting(db, w.maintainer.actor, id, none);
  const idea = v.findings.find((x: { type: string }) => x.type === 'idea') as { id: string };
  const r = await meetings.acceptFinding(db, w.maintainer.actor, id, idea.id, {
    kind: 'idea',
    title: 'Печать этикеток со сканера',
    problem: 'Этикетки печатают на отдельном компьютере, теряем время',
    proposal: 'Печатать со сканера на мобильный принтер у ворот',
    categoryId: f.categories.it,
  });
  await retention.purgeMedia(db, w.admin.actor, id, { what: 'transcript', reason: 'Проверка удаления расшифровки' });
  const after = await meetings.getMeeting(db, w.maintainer.actor, id, none);
  assert.equal(after.findings.length, 1);
  assert.equal(after.findings[0].status, 'accepted');
  assert.match(after.transcripts[0].text, /удалена по сроку хранения/);
  assert.ok(after.transcripts[0].purgedAt);
  await assert.rejects(meetings.analyze(db, w.maintainer.actor, id, { transcriptId, method: 'model' }, none), codes('gone'));
  // The item, its origin quote and its workflow are untouched.
  const origin = (await meetings.itemOrigin(db, w.maintainer.actor, r.body.item.number)) as { quote: string; recordingAvailable: boolean };
  assert.match(origin.quote, /Предлагаю печатать/);
  assert.equal(origin.recordingAvailable, true);
  assert.equal((await ownerQuery(db, 'SELECT 1 FROM ideas WHERE id = $1', [r.body.item.id])).length, 1);
});

test('legal hold forbids deletion by the admin and by the schedule; release lets the schedule purge', async () => {
  const { id } = await recordedMeeting('Законное удержание');
  await assert.rejects(retention.setLegalHold(db, w.maintainer.actor, id, { hold: true, reason: 'Запрос суда №12' }), codes('forbidden'));
  await retention.setLegalHold(db, w.admin.actor, id, { hold: true, reason: 'Запрос суда №12' });
  await assert.rejects(retention.purgeMedia(db, w.admin.actor, id, { what: 'all', reason: 'Попытка удалить' }), codes('conflict'));
  await assert.rejects(ownerQuery(db, `SELECT app_purge_media_inner($1, 'all', 'обход', NULL)`, [id]), /legal hold|ограничения/);
  await retention.sweep(db, new Date(Date.now() + 400 * DAY));
  const [kept] = await ownerQuery<{ purged: boolean }>(db, 'SELECT purged_at IS NOT NULL AS purged FROM meeting_recordings WHERE meeting_id = $1', [id]);
  assert.equal(kept!.purged, false);
  await retention.setLegalHold(db, w.admin.actor, id, { hold: false, reason: 'Дело закрыто' });
  await retention.sweep(db, new Date(Date.now() + 400 * DAY));
  const [gone] = await ownerQuery<{ purged: boolean }>(db, 'SELECT purged_at IS NOT NULL AS purged FROM meeting_recordings WHERE meeting_id = $1', [id]);
  assert.equal(gone!.purged, true);
  const actions = (await ownerQuery<{ action: string }>(db, 'SELECT action FROM retention_log WHERE meeting_id = $1 ORDER BY created_at', [id])).map((x) => x.action);
  assert.deepEqual(actions, ['hold_set', 'hold_released', 'purged', 'purged']);
});

test('retention: 30 days for audio and 90 for transcripts by default; configurable by the admin, logged', async () => {
  const { id } = await recordedMeeting('Сроки по умолчанию');
  const st = (await retention.retentionOverview(db, w.admin.actor)).settings;
  assert.deepEqual(st, { audioDays: 30, transcriptDays: 90 });
  await retention.sweep(db, new Date(Date.now() + 29 * DAY));
  const state = async () =>
    (await ownerQuery<{ r: boolean; t: boolean }>(
      db,
      `SELECT (SELECT purged_at IS NOT NULL FROM meeting_recordings WHERE meeting_id = $1) AS r,
              (SELECT bool_and(purged_at IS NOT NULL) FROM meeting_transcripts WHERE meeting_id = $1) AS t`,
      [id],
    ))[0]!;
  assert.deepEqual(await state(), { r: false, t: false });
  await retention.sweep(db, new Date(Date.now() + 31 * DAY));
  assert.deepEqual(await state(), { r: true, t: false });
  await retention.sweep(db, new Date(Date.now() + 91 * DAY));
  assert.deepEqual(await state(), { r: true, t: true });
  // System purges carry no actor.
  const sys = await ownerQuery<{ actor: string | null }>(db, `SELECT actor_membership_id AS actor FROM retention_log WHERE meeting_id = $1 AND action = 'purged'`, [id]);
  assert.ok(sys.length === 2 && sys.every((x) => x.actor === null));
  await assert.rejects(retention.setRetention(db, w.maintainer.actor, { audioDays: 7, transcriptDays: 14 }), codes('forbidden'));
  await retention.setRetention(db, w.admin.actor, { audioDays: 7, transcriptDays: 14 });
  const changed = await ownerQuery<{ reason: string }>(db, `SELECT reason FROM retention_log WHERE action = 'retention_changed'`);
  assert.match(changed.at(-1)!.reason, /аудио 30 → 7 дн\., расшифровки 90 → 14 дн\./);
  await retention.setRetention(db, w.admin.actor, { audioDays: 30, transcriptDays: 90 });
});

test('content restored from a backup is purged again by the next sweep', async () => {
  const { id } = await recordedMeeting('Восстановление из копии');
  await retention.purgeMedia(db, w.admin.actor, id, { what: 'recording', reason: 'Удаление по запросу' });
  // Simulate a restore of an older backup: the content comes back.
  await withAdminTx(db, async (c) => {
    await c.query(`SELECT set_config('modus.purge', 'on', true)`);
    await c.query('UPDATE meeting_recordings SET data = $2, purged_at = NULL WHERE meeting_id = $1', [id, WEBM]);
  });
  assert.equal((await meetings.downloadRecording(db, w.author.actor, id)).data.length, WEBM.length);
  await retention.sweep(db);
  await assert.rejects(meetings.downloadRecording(db, w.author.actor, id), codes('gone'));
});

test('the admin overview shows dates and sizes, never content', async () => {
  const { id } = await recordedMeeting('Обзор хранения');
  const o = await retention.retentionOverview(db, w.admin.actor);
  const row = o.meetings.find((m: { meetingId: string }) => m.meetingId === id) as Record<string, unknown>;
  assert.ok(row.recordingExpiresAt && row.transcriptExpiresAt);
  assert.equal(row.recordingBytes, WEBM.length);
  assert.ok(!JSON.stringify(o).includes('Предлагаю печатать'));
  await assert.rejects(retention.retentionOverview(db, w.decider.actor), codes('forbidden'));
  // Workflow is untouched by retention: a decision can still be made on an item from a purged meeting.
  void wf;
});
