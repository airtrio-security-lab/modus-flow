import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as legacy from '../../platform/modules/legacy.ts';
import * as meetings from '../../platform/modules/meetings.ts';
import * as retention from '../../platform/modules/retention.ts';
import * as titles from '../../platform/modules/titles.ts';
import * as wf from '../../platform/modules/workflow.ts';
import { listInbox, savePreferences } from '../../platform/modules/notifications.ts';
import { longestSharedRun, templateNote } from '../../platform/domain/legacy.ts';
import { freshDatabase, ownerQuery, person, world, type Person } from './support/db.ts';
import { feedbackOrg, submit } from './support/feedback.ts';

/**
 * «Наследие Королевства» (ADR-0017): one knowledge model, three levels; every level change
 * is a deliberate act of the right person; versions and transitions are never rewritten;
 * the archivist role and game titles open no confidential material; knowledge does not
 * carry transcripts past their retention period; the four royal messages come from real
 * transitions and lead to the material.
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
  const a = await person(db, w.acmeId, 'Архивариус Демо', ['employee'], 'Канцелярия');
  await legacy.setArchivist(db, w.admin.actor, a.membershipId, true);
  archivist = { ...a, actor: { ...a.actor, roles: ['employee', 'archivist'] } };
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const asUser = (p: { actor: typeof w.author.actor }, sql: string, params: unknown[] = []) =>
  withTx(db, { userId: p.actor.userId, orgId: p.actor.orgId, membershipId: p.actor.membershipId }, (c) => c.query(sql, params));
const inboxOf = async (p: { actor: typeof w.author.actor }, event: string) => (await listInbox(db, p.actor)).filter((n) => n.event === event);

const TRANSCRIPT = `[00:00] Мария Ведущая: Начинаем разбор приёмки. Запись идёт, все согласились.
[00:07] Кирилл Демо: Машины стоят у ворот по сорок минут, потому что этикетки печатают на одном компьютере в конторе склада.
[00:18] Анна Коллега: Предлагаю печатать этикетку прямо со сканера на мобильный принтер у ворот и держать один запасной.
[00:29] Начальник Склада: Согласен на пилот у первых ворот, если будет запасной принтер.`;
const COPIED = 'Машины стоят у ворот по сорок минут, потому что этикетки печатают на одном компьютере в конторе склада';

const item = async (title: string) =>
  (await submit(db, w.author, { kind: 'idea', title, proposal: 'Печатать этикетки прямо у ворот приёмки со сканера', departmentId: f.departments.sklad })).body.item.number;
const decideMerge = (n: number) => wf.decide(db, f.head.actor, n, { outcome: 'merge', rationale: 'Пилот у первых ворот: дешёвый принтер, выигрыш во времени приёмки', implementer: w.colleague.membershipId });

const CARD = {
  problem: 'Машины ждали приёмки около 40 минут: этикетки печатались только в конторе склада.',
  options: 'Печать в конторе (как было); мобильный принтер у ворот; предварительная печать по заявке поставщика.',
  argumentsFor: 'Мобильный принтер дешёвый, этикетка печатается там, где товар.',
  argumentsAgainst: 'Без запасного принтера поломка остановит приёмку.',
  decision: 'Печатать этикетку со сканера на мобильный принтер у ворот, держать запасной принтер.',
  reasons: 'Самый быстрый вариант при низкой цене; риск поломки закрыт запасным принтером.',
  actions: [{ what: 'Пилот у ворот №1', due: '2026-11-20' }],
};

test('pure: the copy guard counts consecutive shared words; the note is a labelled template', () => {
  assert.equal(longestSharedRun('Решили печатать у ворот', 'мы решили печатать этикетки у ворот'), 2);
  assert.equal(longestSharedRun(`Итог: ${COPIED}.`, TRANSCRIPT), 17);
  assert.equal(longestSharedRun('', TRANSCRIPT), 0);
  const note = templateNote({ title: 'Печать у ворот', level: 'library', card: CARD, createdAt: '2026-11-11T10:00:00Z', applications: 2 });
  assert.match(note, /^«Печать у ворот» — библиотека решений, с 2026-11-11\. Проблема: Машины ждали/);
  assert.match(note, /Применено повторно: 2\.$/);
});

test('the archivist role: only an admin grants it, it is audited, guests cannot hold it, it opens nothing', async () => {
  const x = await person(db, w.acmeId, 'Стажёр Демо', ['employee'], 'Склад');
  await assert.rejects(legacy.setArchivist(db, w.maintainer.actor, x.membershipId, true), codes('forbidden'));
  // Even bypassing the module check, the database refuses a non-admin.
  await assert.rejects(asUser(w.maintainer, 'SELECT app_set_archivist($1, true)', [x.membershipId]), codes('forbidden', '42501'));
  await assert.rejects(ownerQuery(db, `UPDATE memberships SET roles = ARRAY['archivist'], access = 'guest' WHERE id = $1`, [x.membershipId]));
  const audit = await ownerQuery<{ action: string }>(db, `SELECT action FROM audit_events WHERE entity_id = $1`, [archivist.membershipId]);
  assert.deepEqual(audit.map((a) => a.action), ['role.archivist_granted']);
  // A «King» title gives an employee no right to curate; the archivist sees no meeting material.
  await titles.assignTitle(db, w.admin.actor, w.author.membershipId, { rank: 'king' });
  await assert.rejects(legacy.register(db, w.author.actor, { kind: 'problem', title: 'Попытка', card: CARD, sources: [{ type: 'idea', number: await item('Проба прав') }] }), codes('forbidden'));
  for (const t of ['meeting_transcripts', 'meetings', 'protocol_candidates']) assert.equal((await asUser(archivist, `SELECT 1 FROM ${t}`)).rowCount, 0, t);
  // No write path except the checked functions: nothing can be moved by XP, likes or views.
  const priv = await ownerQuery<{ t: string; ins: boolean; upd: boolean }>(
    db,
    `SELECT t, has_table_privilege('modus_app', t, 'INSERT') AS ins, has_table_privilege('modus_app', t, 'UPDATE') AS upd
       FROM unnest(ARRAY['knowledge_items','knowledge_versions','knowledge_sources','knowledge_transitions','knowledge_applications']) t`,
  );
  assert.ok(priv.every((p) => !p.ins && !p.upd), JSON.stringify(priv));
});

test('demo chain: meeting → chronicle → council decision → confirmed result → library → re-application → Higher Archive', async () => {
  // 1. A meeting with everyone's consent and a transcript.
  const n = await item('Приёмка: этикетки у ворот');
  const mid = (
    await meetings.createMeeting(db, w.maintainer.actor, {
      title: 'Разбор приёмки',
      ideaNumber: n,
      participants: [w.author.membershipId, w.colleague.membershipId, f.head.membershipId],
      organizerConsent: true,
    })
  ).body.id;
  for (const p of [w.author, w.colleague, f.head]) await meetings.setConsent(db, p.actor, mid, 'given');
  await meetings.addTranscript(db, w.maintainer.actor, mid, { text: TRANSCRIPT, source: 'manual' });

  // 2. Registration in the chronicle — a retold card; a pasted transcript passage is refused.
  const sources = [{ type: 'idea' as const, number: n }, { type: 'meeting' as const, id: mid }];
  await assert.rejects(
    legacy.register(db, w.maintainer.actor, { kind: 'method', title: 'Печать этикеток у ворот', card: { ...CARD, problem: COPIED }, sources }),
    (e: { code?: string; message?: string }) => e.code === 'validation_failed' && /фрагмент расшифровки заседания \(17 слов подряд\)/.test(e.message ?? ''),
  );
  await assert.rejects(legacy.register(db, w.maintainer.actor, { kind: 'method', title: 'Без источника', card: CARD, sources: [] as never }));
  const { id } = await legacy.register(db, w.maintainer.actor, { kind: 'method', title: 'Печать этикеток у ворот', card: CARD, sources, reason: 'Итог разбора приёмки' });

  // Default visibility: only those who can open every source (here — the meeting's participants).
  const seen = async (p: Person) => (await legacy.list(db, p.actor, { q: 'этикетки' })).items.some((i) => i.id === id);
  assert.deepEqual(await Promise.all([w.author, f.head, archivist, w.decider, w.admin, w.outsider].map(seen)), [true, true, false, false, false, false]);
  const row = (await legacy.list(db, w.author.actor, { q: 'этикетки' })).items.find((i) => i.id === id)!;
  assert.deepEqual([row.hall, row.proof, row.sources], ['Летопись', 'зарегистрировано, не проверено', ['обращение №' + n, 'заседание']]);

  // 3. The council decides; 4. the result is confirmed (implementation report + effect).
  await decideMerge(n);
  await wf.completeImplementation(db, w.colleague.actor, n, { report: 'Принтер у ворот №1 работает, приёмка машины — 12 минут' });

  // 5. Library: proposed by a curator, checked by the archivist — a second person.
  await legacy.act(db, w.maintainer.actor, id, { action: 'library_proposed', reason: 'Решение принято и внедрено' });
  await assert.rejects(legacy.act(db, w.maintainer.actor, id, { action: 'library_accepted' }), codes('forbidden'));
  // The archivist role does not open the closed meeting: the archivist cannot even see the entry.
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'library_accepted' }), codes('forbidden'));
  await assert.rejects(legacy.get(db, archivist.actor, id), codes('not_found'));
  // An approver opens the retold card to the organization — the meeting itself stays closed.
  await assert.rejects(legacy.act(db, w.maintainer.actor, id, { action: 'opened_to_organization', reason: 'Для всех' }), codes('forbidden'));
  await legacy.act(db, f.head.actor, id, { action: 'opened_to_organization', reason: 'Карточка пересказана, расшифровка не перенесена' });
  const forArchivist = await legacy.get(db, archivist.actor, id);
  assert.equal(forArchivist.sources.find((s) => s.type === 'meeting')!.label, 'Закрытое заседание — доступно только участникам');
  assert.equal(forArchivist.can.library_accepted, true);

  await savePreferences(db, f.head.actor, { style: 'royal', addressForm: 'milord', groupRepeats: true, muted: [] });
  await savePreferences(db, w.decider.actor, { style: 'royal', addressForm: 'milord', groupRepeats: true, muted: [] });
  assert.equal((await legacy.act(db, archivist.actor, id, { action: 'library_accepted' })).level, 'library');
  const inLib = (await inboxOf(f.head, 'knowledge_in_library'))[0]!;
  assert.equal(inLib.royal, 'Милорд, ваше решение «Печать этикеток у ворот» внесено в Библиотеку.');
  assert.equal(inLib.knowledgeId, id);
  assert.match(inLib.message, /^Архивариус Демо \(Архивариус\) вносит «Печать этикеток у ворот» в Библиотеку решений$/);

  // The archivist's conclusion is a new version with a reason; old versions stay.
  const conclusion = {
    ...CARD,
    results: 'Время приёмки машины: 40 → 12 минут за две недели пилота.',
    positive: 'Печать у места приёмки убрала очередь.',
    negative: 'Первая неделя без запасного принтера — один простой на 20 минут.',
    archiveCategory: 'method' as const,
    proof: 'Отчёт о внедрении №' + n + ', повторное применение на втором складе.',
    applicability: 'Склады с приёмкой у ворот и сканерами с Bluetooth.',
    lastChecked: '2026-11-11',
    basis: 'Воспроизведено на другом участке с тем же результатом.',
  };
  assert.equal((await legacy.revise(db, archivist.actor, id, { title: 'Печать этикеток у ворот', card: conclusion, reason: 'Заключение для Высшего Архива' })).version, 2);
  // A method needs a confirmed re-application on ANOTHER item.
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Метод проверен' }), codes('validation_failed'));
  await assert.rejects(legacy.addApplication(db, archivist.actor, id, { ideaNumber: n, note: 'То же обращение' }), codes('validation_failed'));

  // 6. Re-application on a second item: counts only once that item is implemented.
  const n2 = await item('Приёмка на втором складе');
  await decideMerge(n2);
  await legacy.addApplication(db, archivist.actor, id, { ideaNumber: n2, note: 'Тот же метод на воротах второго склада' });
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Метод проверен' }), (e: { message?: string }) => /повторное применение/.test(e.message ?? ''));
  await wf.completeImplementation(db, w.colleague.actor, n2, { report: 'Второй склад: приёмка 14 минут' });
  await legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Метод воспроизведён дважды' });
  const submitted = (await inboxOf(w.decider, 'knowledge_submitted'))[0]!;
  assert.equal(submitted.royal, 'Милорд, Архивариус представил новое знание для рассмотрения Советом: «Печать этикеток у ворот».');
  assert.equal(submitted.knowledgeId, id);
  // While a review is pending the card is not edited under the reviewer.
  await assert.rejects(legacy.revise(db, archivist.actor, id, { title: 'Печать этикеток у ворот', card: conclusion, reason: 'Правка во время рассмотрения' }), codes('validation_failed'));

  // 7. Approval by an authorized person — not the archivist.
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_approved' }), codes('forbidden'));
  assert.equal((await legacy.act(db, w.decider.actor, id, { action: 'archive_approved', reason: 'Утверждаю' })).level, 'archive');
  assert.equal((await inboxOf(f.head, 'knowledge_archived'))[0]!.royal, 'Милорд, Совет утвердил включение метода «Печать этикеток у ворот» в Высший Архив.');
  assert.equal((await inboxOf(archivist, 'knowledge_archived')).length, 1);

  const page = await legacy.get(db, w.author.actor, id);
  assert.deepEqual([page.hall, page.proof, page.version, page.archiveCategoryTitle], ['Высший Архив', 'утверждено как наследие', 2, 'Проверенный воспроизводимый метод']);
  assert.ok(page.lastVerifiedAt);
  assert.deepEqual(page.applications.map((a) => [a.number, a.implemented]), [[n2, true]]);
  assert.deepEqual(
    page.transitions.map((t) => t.action),
    ['registered', 'library_proposed', 'opened_to_organization', 'library_accepted', 'revised', 'application_added', 'archive_proposed', 'archive_approved'],
  );
  // The chronicle is assembled from the real records of the sources.
  const what = page.timeline.map((e) => e.what);
  for (const x of ['Поднят вопрос «Приёмка: этикетки у ворот»', 'Заседание «Разбор приёмки»', 'Решение: внедрять', 'Отчёт о внедрении', 'Включение в Высший Архив утверждено']) assert.ok(what.includes(x), x);
  assert.equal(page.versions[1]!.reason, 'Итог разбора приёмки');

  // History is append-only; the archive is not edited without re-verification.
  await assert.rejects(legacy.revise(db, archivist.actor, id, { title: 'Тихая правка', card: conclusion, reason: 'Подправить' }), codes('validation_failed'));
  await assert.rejects(asUser(archivist, `UPDATE knowledge_items SET level = 'chronicle' WHERE id = $1`, [id]));
  await assert.rejects(ownerQuery(db, `UPDATE knowledge_versions SET card = '{}' WHERE knowledge_id = $1`, [id]));
  await assert.rejects(ownerQuery(db, `DELETE FROM knowledge_transitions WHERE knowledge_id = $1`, [id]));
  await assert.rejects(ownerQuery(db, `DELETE FROM knowledge_items WHERE id = $1`, [id]));

  // Re-verification and «outdated» keep every version and every step.
  await assert.rejects(legacy.act(db, w.author.actor, id, { action: 'reverify_requested', reason: 'Сомневаюсь' }), codes('forbidden'));
  await assert.rejects(legacy.act(db, w.maintainer.actor, id, { action: 'reverify_requested' }), codes('validation_failed'));
  await legacy.act(db, w.maintainer.actor, id, { action: 'reverify_requested', reason: 'Сменили модель сканеров' });
  assert.equal((await inboxOf(archivist, 'knowledge_reverify'))[0]!.royal, 'Коллега, внимание: ранее принятый метод «Печать этикеток у ворот» требует повторной проверки.');
  assert.equal((await inboxOf(f.head, 'knowledge_reverify'))[0]!.royal, 'Милорд, внимание: ранее принятый метод «Печать этикеток у ворот» требует повторной проверки.');
  await legacy.revise(db, archivist.actor, id, { title: 'Печать этикеток у ворот', card: { ...conclusion, applicability: 'Только сканеры с Bluetooth 5 и выше.' }, reason: 'Новые сканеры: уточнена применимость' });
  await legacy.act(db, archivist.actor, id, { action: 'outdated', reason: 'Перешли на RFID-метки, метод больше не используется' });
  const old = await legacy.get(db, w.author.actor, id);
  assert.deepEqual([old.level, old.status, old.statusTitle, old.versions.length], ['archive', 'outdated', 'устарело', 3]);
  assert.equal(old.versions.at(-1)!.card.problem, CARD.problem);

  // Search across halls shows the level and the status; another organization sees nothing.
  const found = (await legacy.list(db, w.colleague.actor, { q: 'этикеток' })).items.find((i) => i.id === id)!;
  assert.deepEqual([found.hall, found.statusTitle], ['Высший Архив', 'устарело']);
  // The archive volume in the catalogue carries the archivist's conclusion of the current version (ADR-0034):
  // the same card the row comes from; a record of the Chronicle without a conclusion has none.
  assert.equal(found.conclusion?.applicability, 'Только сканеры с Bluetooth 5 и выше.');
  assert.ok(found.conclusion?.category && found.conclusion.proof && found.conclusion.basis);
  assert.equal((await legacy.list(db, w.colleague.actor, { level: 'library' })).items.some((i) => i.id === id), false);
  assert.equal((await legacy.list(db, w.outsider.actor, {})).items.length, 0);
  assert.equal((await asUser(w.outsider, 'SELECT 1 FROM knowledge_versions')).rowCount, 0);

  // Retention: the transcript is purged on schedule; the knowledge keeps only its retold card.
  await retention.purgeMedia(db, w.admin.actor, mid, { what: 'transcript', reason: 'Истёк срок хранения расшифровки' });
  const after = await legacy.get(db, w.author.actor, id);
  assert.match(after.sources.find((s) => s.type === 'meeting')!.detail!, /расшифровка удалена по сроку хранения/);
  assert.equal(after.card.problem, CARD.problem);
});

test('rules of approval: a second pair of eyes, conclusions need their grounds, notifications only to those who may read', async () => {
  const n = await item('Урок: инвентаризация без пересчёта');
  await decideMerge(n);
  const { id } = await legacy.register(db, w.maintainer.actor, { kind: 'lesson', title: 'Инвентаризация без пересчёта', card: CARD, sources: [{ type: 'idea', number: n }] });
  // Without problem, decision and reasons nothing goes to the library.
  const thin = await legacy.register(db, w.maintainer.actor, { kind: 'problem', title: 'Пустая запись', card: { problem: 'Коротко' }, sources: [{ type: 'idea', number: n }] });
  await assert.rejects(legacy.act(db, w.maintainer.actor, thin.id, { action: 'library_proposed', reason: 'Попробуем' }), (e: { message?: string }) => /проблему, решение и причины/.test(e.message ?? ''));
  // An archivist who proposed does not accept their own proposal.
  await legacy.act(db, archivist.actor, id, { action: 'library_proposed', reason: 'Важный урок' });
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'library_accepted' }), (e: { message?: string }) => /вторая пара глаз/.test(e.message ?? ''));
  await legacy.act(db, archivist.actor, id, { action: 'library_rejected', reason: 'Сам отзываю: добавлю результаты' });
  await legacy.act(db, w.maintainer.actor, id, { action: 'library_proposed', reason: 'Добавлены результаты' });
  await legacy.act(db, archivist.actor, id, { action: 'library_accepted' });
  // A lesson needs the negative experience; the conclusion needs proof, applicability, a date and grounds.
  await legacy.revise(db, archivist.actor, id, { title: 'Инвентаризация без пересчёта', card: { ...CARD, archiveCategory: 'lesson', proof: 'Акт расхождений по итогам квартала' }, reason: 'Черновик заключения' });
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Урок доказан' }), (e: { message?: string }) => /доказанность, область применимости/.test(e.message ?? ''));
  const full = { ...CARD, archiveCategory: 'lesson' as const, proof: 'Акт расхождений по итогам квартала', applicability: 'Все склады с ручным учётом остатков', lastChecked: '2026-11-11', basis: 'Ошибка стоила недостачи и повторного пересчёта' };
  await legacy.revise(db, archivist.actor, id, { title: 'Инвентаризация без пересчёта', card: full, reason: 'Заключение без отрицательного опыта' });
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Урок доказан' }), (e: { message?: string }) => /отрицательный опыт/.test(e.message ?? ''));
  await legacy.revise(db, archivist.actor, id, { title: 'Инвентаризация без пересчёта', card: { ...full, negative: 'Квартал закрыли с недостачей, которую нашли только при ручном пересчёте.' }, reason: 'Описан отрицательный опыт' });
  await legacy.act(db, archivist.actor, id, { action: 'archive_proposed', reason: 'Урок доказан актом' });
  // The author of the conclusion — even holding an approver role — does not approve it.
  await legacy.setArchivist(db, w.admin.actor, f.escalation.membershipId, true);
  const both = { ...f.escalation.actor, roles: [...f.escalation.actor.roles, 'archivist' as const] };
  await assert.rejects(legacy.act(db, archivist.actor, id, { action: 'archive_rejected', reason: 'Отзыв' }), codes('forbidden'));
  await legacy.act(db, w.decider.actor, id, { action: 'archive_rejected', reason: 'Нужен второй акт' });
  await legacy.act(db, both, id, { action: 'archive_proposed', reason: 'Второй акт приложен' });
  await assert.rejects(legacy.act(db, both, id, { action: 'archive_approved' }), (e: { message?: string }) => /Автор заключения/.test(e.message ?? ''));
  await legacy.act(db, w.decider.actor, id, { action: 'archive_approved', reason: 'Утверждаю урок' });
  await legacy.setArchivist(db, w.admin.actor, f.escalation.membershipId, false);
  // Notifications are proven by a transition and go only to readers who may see the knowledge.
  await assert.rejects(asUser(w.maintainer, `SELECT app_notify_knowledge('knowledge_archived', $1, ARRAY[$2]::uuid[], 'forged')`, [id, w.author.membershipId]), codes('forbidden', '42501'));
  await assert.rejects(asUser(w.outsider, `SELECT app_notify_knowledge('knowledge_archived', $1, ARRAY[$2]::uuid[], 'x')`, [id, w.author.membershipId]));
});

test('helper without AI: labelled word matching, possible contradictions, a template note; draft from an item', async () => {
  const n = await item('Печать этикеток в конторе');
  const draft = await legacy.draftFromItem(db, w.maintainer.actor, n);
  assert.deepEqual([draft.title, draft.sources, draft.card.initiator], ['Печать этикеток в конторе', [{ type: 'idea', number: n }], w.author.membershipId]);
  assert.match(draft.note, /ничего не сохранено/);
  const a = await legacy.register(db, w.maintainer.actor, { kind: 'decision', title: 'Печать этикеток у ворот склада', card: CARD, sources: [{ type: 'idea', number: n }] });
  const b = await legacy.register(db, w.maintainer.actor, {
    kind: 'decision',
    title: 'Печать этикеток у ворот склада — альтернатива',
    card: { ...CARD, decision: 'Оставить централизованную печать в конторе и нанять второго оператора.' },
    sources: [{ type: 'idea', number: n }],
  });
  const h = await legacy.helper(db, w.maintainer.actor, a.id);
  assert.equal(h.mode, 'template');
  assert.equal(h.ai.connected, false);
  assert.match(h.label, /не смысловой анализ/);
  assert.ok(h.similar.some((s) => s.id === b.id));
  assert.ok(h.contradictions.some((x) => x.id === b.id));
  assert.match(h.noteLabel, /не AI/);
  assert.match(h.note, /^«Печать этикеток у ворот склада» — летопись/);
});

test('AI-Архивариус: «не подключён» without a model; with a model only references to shown candidates survive', async () => {
  const n = await item('Маркировка паллет на приёмке');
  const a = await legacy.register(db, w.maintainer.actor, { kind: 'decision', title: 'Маркировка паллет у ворот склада', card: CARD, sources: [{ type: 'idea', number: n }] });
  const b = await legacy.register(db, w.maintainer.actor, { kind: 'decision', title: 'Маркировка паллет у ворот склада — второй вариант', card: CARD, sources: [{ type: 'idea', number: n }] });
  // The candidates the model is shown are numbered K1… in the order of the helper without AI.
  const refOfB = `K${(await legacy.helper(db, w.maintainer.actor, a.id)).similar.findIndex((x) => x.id === b.id) + 1}`;
  assert.match(refOfB, /^K[1-5]$/);
  const off = await legacy.helperAi(db, w.maintainer.actor, a.id, null);
  assert.equal(off.connected, false);
  assert.match(off.note, /не подключён/);
  await assert.rejects(legacy.helperAi(db, w.author.actor, a.id, null), codes('forbidden'), 'only curators run the paid assistant');
  const model = { provider: 'anthropic' as const, url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', apiKey: 'sk-test' };
  let sent = '';
  const answer = (text: string) =>
    (async (_u: string | URL | Request, init?: RequestInit) => {
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  const good = await legacy.helperAi(
    db,
    w.maintainer.actor,
    a.id,
    model,
    answer(JSON.stringify({ summary: 'Этикетки печатают у ворот, чтобы не ждать контору.', verdict: 'needs_work', duplicates: [{ ref: refOfB, why: 'То же решение для той же проблемы' }, { ref: 'K9', why: 'выдуманная ссылка' }], related: [{ ref: 'I7', why: 'нет такого' }], gaps: ['Не указано, кто отвечает за принтер'] })),
  );
  assert.ok(good.connected && good.ok);
  if (good.connected && good.ok) {
    assert.deepEqual(good.duplicates.map((d) => d.id), [b.id], 'the made-up K9 is dropped');
    assert.deepEqual([good.related.length, good.dropped, good.remote, good.verdict], [0, 2, true, 'needs_work']);
    assert.match(good.note, /за пределы компании/);
    assert.equal(good.model, 'облачная модель claude-haiku-5-5 (Anthropic)');
  }
  assert.match(sent, /Маркировка паллет у ворот склада/);
  assert.equal(sent.includes('sk-test'), false, 'the key travels in a header, never in the text');
  const junk = await legacy.helperAi(db, w.maintainer.actor, a.id, model, answer('простите, не могу'));
  assert.ok(junk.connected && !junk.ok);
});
