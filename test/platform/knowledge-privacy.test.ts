import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as legacy from '../../platform/modules/legacy.ts';
import * as kp from '../../platform/modules/knowledge-privacy.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as retention from '../../platform/modules/retention.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { findSensitive, kindsText, meetingOverlap } from '../../platform/domain/privacy.ts';
import { freshDatabase, ownerQuery, person, world, type Person } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * Personal data in organizational memory (ADR-0018): checked at any length on every write;
 * opening to the organization checks every version; erasure and pseudonymization only by an
 * admin with a legal basis, blocked by a legal hold, logged without the erased content,
 * re-applied after a restore and through the ledger. Negative tests for access and erasure.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;
let archivist: Person;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
  const a = await person(db, w.acmeId, 'Лира Хранитель', ['employee'], 'Канцелярия');
  await legacy.setArchivist(db, w.admin.actor, a.membershipId, true);
  archivist = { ...a, actor: { ...a.actor, roles: ['employee', 'archivist'] } };
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const says = (re: RegExp, not?: string[]) => (e: { code?: string; message?: string }) =>
  e.code === 'validation_failed' && re.test(e.message ?? '') && !(not ?? []).some((x) => (e.message ?? '').includes(x));
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));
/** Simulates data written before the guards existed, or restored from an old backup (schema owner). */
const inject = (sql: string) => ownerQuery(db, `SELECT set_config('modus.purge', 'on', true); ${sql}`);

const PHONE = '+7 701 555 12 34';
const EMAIL = 'k.demo@acme.kz';
const CARD = {
  problem: 'Поставщик срывал сроки отгрузки, склад простаивал по полдня.',
  decision: 'Ввести слоты разгрузки и штраф поставщику за опоздание по договору.',
  reasons: 'Слоты дают предсказуемую загрузку ворот без найма людей.',
};

test('detector: identifiers, special categories and surnames at any length; messages carry kinds, never values', () => {
  const people = ['Кирилл Демо', 'Анна Коллега'];
  const kinds = (s: string) => findSensitive(s, { people }).map((x) => x.kind);
  assert.deepEqual(kinds(`Звонить ${PHONE}`), ['phone']);
  assert.deepEqual(kinds(`Почта ${EMAIL}`), ['email']);
  assert.deepEqual(kinds('ИИН 900101300123'), ['id_number']);
  assert.deepEqual(kinds('Карта 4400 4301 2345 6781'), ['id_number']);
  assert.deepEqual(kinds('Счёт KZ86125KZT5004100100'), ['iban']);
  assert.deepEqual(kinds('Паспорт № 1234567'), ['document']);
  assert.deepEqual(kinds('Живёт ул. Абая, 15'), ['address']);
  assert.deepEqual(kinds('Был на больничном'), ['health']);
  assert.deepEqual(kinds('Подняли оклад'), ['pay']);
  assert.deepEqual(kinds('Объявлен выговор'), ['discipline']);
  assert.deepEqual(kinds('Согласовано с Анной Коллегой'), ['person']);
  assert.deepEqual(kinds('Не для распространения'), ['confidential']);
  // Ordinary operational text passes: lowercase words that look like surnames, numbers, dates.
  assert.deepEqual(kinds('Решили обсудить с коллегой; пилот 2 недели, 40 минут вместо 12'), []);
  assert.equal(kindsText(findSensitive(`${PHONE} и ${EMAIL}`)), 'номер телефона, адрес электронной почты');
  assert.deepEqual(meetingOverlap('Бюджет пилота 340 тысяч', '[00:07] Мария: бюджет 340 тысяч, не больше'), ['number']);
  assert.deepEqual(meetingOverlap('Пилот у ворот', '[00:07] Мария: пилот у ворот'), []);
});

let k: string;
let mid: string;
let n: number;

test('writing knowledge: personal data refused in every text at any length, without echoing it', async () => {
  n = (await submit(db, w.author, { kind: 'idea', title: 'Слоты разгрузки', proposal: 'Ввести слоты разгрузки для поставщиков', departmentId: f.departments.sklad })).body.item.number;
  mid = (await meetings.createMeeting(db, w.maintainer.actor, { title: 'Разбор поставок', ideaNumber: n, participants: [w.author.membershipId, w.colleague.membershipId, f.head.membershipId], organizerConsent: true })).body.id;
  for (const p of [w.author, w.colleague, f.head]) await meetings.setConsent(db, p.actor, mid, 'given');
  await meetings.addTranscript(db, w.maintainer.actor, mid, { text: '[00:00] Мария Ведущая: бюджет на слоты 340 тысяч, не больше.\n[00:09] Анна Коллега: согласна.', source: 'manual' });
  const sources = [{ type: 'idea' as const, number: n }, { type: 'meeting' as const, id: mid }];
  const reg = (card: Record<string, string>, extra: Partial<{ reason: string; title: string }> = {}) =>
    legacy.register(db, w.maintainer.actor, { kind: 'decision', title: extra.title ?? 'Слоты разгрузки', card: { ...CARD, ...card }, sources, reason: extra.reason });
  await assert.rejects(reg({ problem: `Звонить поставщику ${PHONE}` }), says(/«Исходная проблема»: номер телефона/, [PHONE, '555']));
  await assert.rejects(reg({ results: 'Кладовщик ушёл на больничный' }), says(/«Результаты»: сведения о здоровье/));
  await assert.rejects(reg({ reasons: 'Так решил Демо' }), says(/«Причины выбора»: фамилия сотрудника в тексте.*«Ответственные»/));
  await assert.rejects(reg({}, { title: 'Премия кладовщику' }), says(/«Название»: сведения о заработной плате/));
  await assert.rejects(reg({}, { reason: `по письму ${EMAIL}` }), says(/«Причина»: адрес электронной почты/, [EMAIL]));
  // Confidentiality markers are allowed while the knowledge is restricted to its sources' readers.
  k = (await reg({ evidence: 'Протокол — не для распространения' })).id;
  // Every other text: version reasons, transition reasons, notes.
  await assert.rejects(legacy.revise(db, w.maintainer.actor, k, { title: 'Слоты разгрузки', card: CARD, reason: `звонок ${PHONE}` }), says(/номер телефона/));
  await assert.rejects(legacy.act(db, w.maintainer.actor, k, { action: 'library_proposed', reason: `согласовано по ${EMAIL}` }), says(/адрес электронной почты/));
  await assert.rejects(legacy.addSource(db, w.maintainer.actor, k, { type: 'idea', number: n, note: 'ИИН 900101300123' }), says(/длинный номер/));
  await assert.rejects(legacy.addApplication(db, w.maintainer.actor, k, { ideaNumber: n, note: 'Паспорт № 1234567 приложен' }), says(/реквизиты документа/));
  await legacy.revise(db, w.maintainer.actor, k, { title: 'Слоты разгрузки', card: { ...CARD, results: 'Бюджет пилота — 340 тысяч.' }, reason: 'Добавлен результат' });
});

test('opening to the organization checks every version, notes and closed-meeting content; rights before content', async () => {
  // Data written before the guards existed: a phone and a surname in version 1, an e-mail in a transition reason.
  await inject(`UPDATE knowledge_versions SET card = jsonb_set(card, '{problem}', to_jsonb('Поставщик ${PHONE} срывал сроки, Демо жаловался'::text)) WHERE knowledge_id = '${k}' AND version = 1;
                UPDATE knowledge_transitions SET reason = 'по письму ${EMAIL}' WHERE knowledge_id = '${k}' AND action = 'revised'`);
  // A non-approver learns nothing about the content.
  await assert.rejects(legacy.act(db, w.maintainer.actor, k, { action: 'opened_to_organization', reason: 'Для всех сотрудников' }), codes('forbidden'));
  await assert.rejects(
    legacy.act(db, f.head.actor, k, { action: 'opened_to_organization', reason: 'Для всех сотрудников' }),
    says(/версия 1, «Исходная проблема»: номер телефона, фамилия сотрудника в тексте.*версия 1, «Доказательства»: пометка о конфиденциальности.*версия 2, «Результаты»: числа из закрытого заседания.*причина в истории переходов: адрес электронной почты/s, [PHONE, EMAIL, 'Демо жал', '340']),
  );
  assert.equal((await ownerQuery<{ v: string }>(db, `SELECT visibility AS v FROM knowledge_items WHERE id = $1`, [k]))[0]!.v, 'sources');
});

test('scan: admin only, places and kinds, never the text; closed knowledge is not titled', async () => {
  for (const p of [w.maintainer, f.head, archivist, w.decider]) await assert.rejects(kp.scan(db, p.actor), codes('forbidden'));
  await assert.rejects(asUser(archivist, 'SELECT * FROM app_knowledge_privacy_material()'), codes('forbidden', '42501'));
  assert.equal((await asUser(w.maintainer, 'SELECT * FROM knowledge_redactions')).rowCount, 0);
  const s = await kp.scan(db, w.admin.actor);
  const entry = s.findings.find((x) => x.id === k)!;
  assert.equal(entry.title, 'Запись, недоступная вам (закрытые источники)');
  assert.deepEqual(entry.places.map((p) => [p.place, p.kinds.join(', ')]), [
    ['версия 1, «Исходная проблема»', 'номер телефона, фамилия сотрудника в тексте'],
    ['версия 1, «Доказательства»', 'пометка о конфиденциальности'],
    ['причина в истории переходов', 'адрес электронной почты'],
  ]);
  const json = JSON.stringify(s);
  for (const secret of [PHONE, EMAIL, 'Демо жаловался', 'не для распространения']) assert.ok(!json.includes(secret), secret);
  const other = await kp.scan(db, w.outsider.actor).catch(() => null);
  assert.ok(other === null || other.findings.every((x) => x.id !== k));
});

test('erasure, negative: wrong role, wrong org, no basis, a dirty reference, legal hold, unknown place, bypass attempts', async () => {
  const places = (await kp.scan(db, w.admin.actor)).findings.find((x) => x.id === k)!.places.map((p) => p.loc);
  const ok = { basis: 'subject_request' as const, ref: 'Запрос ПДн №14/2026', places };
  for (const p of [w.maintainer, archivist, f.head, w.author]) await assert.rejects(kp.erase(db, p.actor, k, ok), codes('forbidden'));
  await assert.rejects(asUser(w.maintainer, `SELECT app_knowledge_erase($1, 'subject_request', 'x-1', '[{"t":"version","v":1,"f":"problem"}]')`, [k]), codes('forbidden', '42501'));
  await assert.rejects(kp.erase(db, w.outsider.actor, k, ok), codes('forbidden', 'not_found'));
  await assert.rejects(asUser(w.admin, `SELECT app_knowledge_erase($1, NULL, 'x-1', '[{"t":"version","v":1,"f":"problem"}]')`, [k]), codes('validation_failed', '23514'));
  await assert.rejects(kp.erase(db, w.admin.actor, k, { ...ok, ref: `звонок ${PHONE}` }), says(/постоянный журнал/, [PHONE]));
  await assert.rejects(kp.erase(db, w.admin.actor, k, { ...ok, ref: 'Жалоба Демо' }), says(/постоянный журнал|повторяет удаляемые/));
  await assert.rejects(kp.erase(db, w.admin.actor, k, { ...ok, places: [{ t: 'version', v: 9, f: 'problem' }] }), says(/Такого места/));
  await assert.rejects(kp.erase(db, w.admin.actor, k, { ...ok, places: [{ t: 'version', v: 1, f: 'card' }] }), says(/Такого места/));
  await retention.setLegalHold(db, w.admin.actor, mid, { hold: true, reason: 'Запрос следственных органов' });
  await assert.rejects(kp.erase(db, w.admin.actor, k, ok), says(/удержанием/));
  await retention.setLegalHold(db, w.admin.actor, mid, { hold: false, reason: 'Удержание снято' });
  // The application role can neither write knowledge nor use the purge bypass.
  await assert.rejects(asUser(w.admin, `SELECT set_config('modus.purge', 'on', true), 1`).then(() => asUser(w.admin, `UPDATE knowledge_versions SET title = 'x' WHERE knowledge_id = $1`, [k])));
  await assert.rejects(ownerQuery(db, `DELETE FROM knowledge_versions WHERE knowledge_id = $1`, [k]));
  await assert.rejects(inject(`DELETE FROM knowledge_versions WHERE knowledge_id = '${k}'`));
  // Nothing changed by the refused attempts.
  assert.equal((await ownerQuery(db, 'SELECT 1 FROM knowledge_redactions')).length, 0);
});

test('erasure: every targeted version and note overwritten, history kept, search and log clean, re-applied after a restore and from the ledger', async () => {
  const places = (await kp.scan(db, w.admin.actor)).findings.find((x) => x.id === k)!.places.map((p) => p.loc);
  const r = await kp.erase(db, w.admin.actor, k, { basis: 'subject_request', ref: 'Запрос ПДн №14/2026', places });
  assert.deepEqual(r, { rowsChanged: 3, places: 3 });
  const rows = await ownerQuery<{ version: number; card: Record<string, string> }>(db, 'SELECT version, card FROM knowledge_versions WHERE knowledge_id = $1 ORDER BY version', [k]);
  assert.equal(rows.length, 2, 'versions are kept');
  assert.equal(rows[0]!.card.problem, '[удалено: персональные данные]');
  assert.equal(rows[1]!.card.problem, CARD.problem, 'untargeted text stays');
  const all = JSON.stringify(await ownerQuery(db, `SELECT (SELECT json_agg(v) FROM knowledge_versions v WHERE v.knowledge_id = $1) AS v, (SELECT json_agg(t) FROM knowledge_transitions t WHERE t.knowledge_id = $1) AS t`, [k]));
  for (const secret of [PHONE, EMAIL, 'Демо жаловался', 'не для распространения']) assert.ok(!all.includes(secret), secret);
  // The history says that and why something was erased — not what.
  const tr = await ownerQuery<{ action: string; reason: string }>(db, `SELECT action, reason FROM knowledge_transitions WHERE knowledge_id = $1 ORDER BY created_at DESC LIMIT 1`, [k]);
  assert.deepEqual(tr[0], { action: 'personal_data_erased', reason: 'основание: subject_request; мест: 3' });
  const log = await ownerQuery(db, 'SELECT * FROM knowledge_redactions');
  const audit = await ownerQuery(db, `SELECT data FROM audit_events WHERE action LIKE 'knowledge.%' AND entity_id = $1`, [k]);
  for (const blob of [JSON.stringify(log), JSON.stringify(audit)]) for (const secret of [PHONE, EMAIL, 'Демо', 'не для распространения', '555']) assert.ok(!blob.includes(secret), secret);
  // Search: the erased text is gone from full-text and similarity search for everyone who can read the knowledge.
  for (const q of ['555', 'жаловался']) assert.equal((await legacy.list(db, w.author.actor, { q })).items.length, 0, q);
  assert.equal((await kp.scan(db, w.admin.actor)).findings.find((x) => x.id === k), undefined);
  // Notifications store no text: only ids and the event; the reader sees the current title.
  const cols = (await ownerQuery<{ c: string }>(db, `SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'notifications' AND data_type IN ('text', 'character varying', 'jsonb')`)).map((x) => x.c).sort();
  assert.deepEqual(cols, ['dedupe_key', 'event_type']);

  // Restore from an older backup brings the value back → the daily job erases it again.
  await inject(`UPDATE knowledge_versions SET card = jsonb_set(card, '{problem}', to_jsonb('Поставщик ${PHONE}'::text)) WHERE knowledge_id = '${k}' AND version = 1`);
  assert.ok((await retention.sweep(db)) >= 1);
  assert.equal((await ownerQuery<{ p: string }>(db, `SELECT card->>'problem' AS p FROM knowledge_versions WHERE knowledge_id = $1 AND version = 1`, [k]))[0]!.p, '[удалено: персональные данные]');
  // A backup older than the erasure has no log either → the ledger kept outside backups brings it back.
  const ledger = await kp.exportLedger(db);
  assert.ok(!JSON.stringify(ledger).includes(PHONE));
  await ownerQuery(db, `ALTER TABLE knowledge_redactions DISABLE TRIGGER knowledge_redactions_append_only; DELETE FROM knowledge_redactions; ALTER TABLE knowledge_redactions ENABLE TRIGGER knowledge_redactions_append_only`);
  await inject(`UPDATE knowledge_versions SET card = jsonb_set(card, '{problem}', to_jsonb('Поставщик ${PHONE}'::text)) WHERE knowledge_id = '${k}' AND version = 1`);
  const imp = await kp.importLedger(db, ledger as never);
  assert.equal(imp.added, 1);
  assert.equal((await ownerQuery<{ p: string }>(db, `SELECT card->>'problem' AS p FROM knowledge_versions WHERE knowledge_id = $1 AND version = 1`, [k]))[0]!.p, '[удалено: персональные данные]');
  // The number from the closed meeting still blocks opening until a person retells it.
  await assert.rejects(legacy.act(db, f.head.actor, k, { action: 'opened_to_organization', reason: 'Для всех сотрудников' }), says(/числа из закрытого заседания/, ['340']));
  await legacy.revise(db, w.maintainer.actor, k, { title: 'Слоты разгрузки', card: { ...CARD, results: 'Бюджет пилота уложился в лимит.' }, reason: 'Пересказ без цифр заседания' });
  await kp.erase(db, w.admin.actor, k, { basis: 'unlawful_processing', ref: 'Служебная записка №7', places: [{ t: 'version', v: 2, f: 'results' }] });
  await legacy.act(db, f.head.actor, k, { action: 'opened_to_organization', reason: 'Карточка без закрытых сведений' });
  const page = await legacy.get(db, archivist.actor, k);
  assert.equal(page.versions.at(-1)!.card.problem, '[удалено: персональные данные]');
  assert.ok(page.transitions.some((t) => (t.action as string) === 'personal_data_erased'));
});

test('pseudonymization of an employee: references and text places, «Сотрудник (обезличен)», once, admin only', async () => {
  const n2 = (await submit(db, w.colleague, { kind: 'idea', title: 'Сканер у ворот', proposal: 'Поставить второй сканер у ворот приёмки', departmentId: f.departments.sklad })).body.item.number;
  await wf.decide(db, f.head.actor, n2, { outcome: 'merge', rationale: 'Второй сканер окупится за месяц по времени приёмки', implementer: w.author.membershipId });
  const { id } = await legacy.register(db, w.maintainer.actor, {
    kind: 'decision',
    title: 'Второй сканер у ворот',
    card: { ...CARD, initiator: w.colleague.membershipId, responsible: [w.colleague.membershipId, f.head.membershipId] },
    sources: [{ type: 'idea', number: n2 }],
  });
  await inject(`UPDATE knowledge_transitions SET reason = 'согласовано с Анной Коллегой' WHERE knowledge_id = '${id}' AND action = 'registered'`);
  const ok = { basis: 'consent_withdrawn' as const, ref: 'Заявление №3/2026' };
  for (const p of [w.maintainer, archivist, w.colleague]) await assert.rejects(kp.pseudonymize(db, p.actor, w.colleague.membershipId, ok), codes('forbidden'));
  await assert.rejects(kp.pseudonymize(db, w.admin.actor, w.colleague.membershipId, { ...ok, ref: 'Заявление Коллега' }), says(/постоянный журнал|повторяет удаляемые/));
  const r = await kp.pseudonymize(db, w.admin.actor, w.colleague.membershipId, ok);
  assert.equal(r.textPlaces, 1);
  await assert.rejects(kp.pseudonymize(db, w.admin.actor, w.colleague.membershipId, ok), says(/уже обезличен/));
  const page = await legacy.get(db, w.author.actor, id);
  assert.equal(page.initiator, null);
  const headName = (await ownerQuery<{ n: string }>(db, 'SELECT display_name AS n FROM employees WHERE membership_id = $1', [f.head.membershipId]))[0]!.n;
  assert.deepEqual(page.responsible, [headName]);
  assert.ok(page.timeline.some((e) => e.what.startsWith('Поднят вопрос') && e.who === 'Сотрудник (обезличен)'));
  assert.equal(page.transitions[0]!.reason, '[удалено: персональные данные]');
  const blob = JSON.stringify(await ownerQuery(db, `SELECT card FROM knowledge_versions WHERE knowledge_id = $1`, [id]));
  assert.ok(!blob.includes(w.colleague.membershipId));
  const log = await ownerQuery<{ scope: string; subject_membership_id: string; request_ref: string; targets: unknown }>(db, `SELECT * FROM knowledge_redactions WHERE scope = 'person'`);
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(log).includes('Коллег'));
  // Nowhere on the knowledge page is the person named any more.
  const again = await legacy.get(db, w.maintainer.actor, id);
  assert.ok(!JSON.stringify(again).includes('Анна Коллега'));
});
