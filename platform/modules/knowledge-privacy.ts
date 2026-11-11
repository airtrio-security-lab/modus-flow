import { z } from 'zod';
import { AppError, forbidden, notFound } from '../domain/errors.ts';
import { LEVEL_TITLE, type Level } from '../domain/legacy.ts';
import type { OrgActor } from '../domain/model.ts';
import { findSensitive, kindsText, KIND_LABEL, LEGAL_BASES, LEGAL_BASIS_TITLE, type SensitiveKind } from '../domain/privacy.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { locOrder, orgPeople, placeOf } from './legacy.ts';

/**
 * Personal data in organizational memory (0013, ADR-0018). Organization admin only.
 *   scan          — every text location of every version and note, checked by the pattern
 *                   detector; the answer carries places and kinds, never the text;
 *   erase         — overwrite chosen locations with a marker, with a legal basis and a request
 *                   reference; the log keeps the fact and the places, not the content;
 *   pseudonymize  — remove an employee's references from all cards and show «Сотрудник
 *                   (обезличен)»; text places with their surname are erased in the same step;
 *   ledger        — the log as a content-free file to keep outside database backups and to
 *                   import after a restore (then the daily job re-applies it).
 * A legal hold on a source meeting blocks erasure. Rows are never deleted.
 */

type Loc = { t: 'version'; v: number; f: string } | { t: 'transition' | 'source' | 'application'; id: string };
const LocSchema = z.union([
  z.object({ t: z.literal('version'), v: z.number().int().positive(), f: z.string().min(1).max(40) }).strict(),
  z.object({ t: z.enum(['transition', 'source', 'application']), id: z.uuid() }).strict(),
]);

const isAdmin = (a: OrgActor) => a.access === 'member' && a.roles.includes('org_admin');
const RU: [RegExp, string][] = [
  [/only an organization admin/, 'Персональные данные в знаниях удаляет только администратор организации'],
  [/a legal basis is required/, 'Укажите законное основание'],
  [/a request reference is required/, 'Укажите номер обращения или документа-основания'],
  [/under legal hold/, 'Источник знания — заседание под удержанием по законному основанию: удаление запрещено, пока удержание не снято'],
  [/nothing to erase/, 'Не выбрано ни одного места'],
  [/unknown erasure target/, 'Такого места в знании нет'],
  [/knowledge not found|member not found/, 'Не найдено в этой организации'],
  [/already pseudonymized/, 'Сотрудник уже обезличен в знаниях'],
];
async function db_<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const hit = RU.find(([re]) => re.test(err?.message ?? ''));
    if (hit && (err.code === '42501' || err.code === '23514')) throw new AppError(err.code === '42501' ? 'forbidden' : 'validation_failed', hit[1]);
    throw e;
  }
}

async function material(c: Client) {
  return (await db_(() => c.query<{ knowledge_id: string; loc: Loc; body: string }>('SELECT knowledge_id, loc, body FROM app_knowledge_privacy_material()'))).rows.sort((a, b) => locOrder(a.loc) - locOrder(b.loc));
}
const ERASED = /^\[(удалено|название удалено)/;

export async function scan(db: Database, actor: OrgActor) {
  if (!isAdmin(actor)) throw forbidden('Проверку персональных данных в знаниях запускает администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    const people = await orgPeople(c);
    const rows = await material(c);
    // Titles only for knowledge the admin may read; the rest is named by its hall.
    const items = (
      await c.query<{ id: string; level: Level; title: string | null }>(
        'SELECT id, level, title FROM app_knowledge_privacy_items()',
      )
    ).rows;
    const byId = new Map<string, { id: string; title: string; hall: string; readable: boolean; places: { loc: Loc; place: string; kinds: string[] }[] }>();
    for (const r of rows) {
      if (!r.body || ERASED.test(r.body)) continue;
      const fs = findSensitive(r.body, { people });
      if (!fs.length) continue;
      const it = items.find((x) => x.id === r.knowledge_id)!;
      const entry = byId.get(r.knowledge_id) ?? {
        id: r.knowledge_id,
        title: it.title ?? 'Запись, недоступная вам (закрытые источники)',
        hall: LEVEL_TITLE[it.level],
        readable: it.title !== null,
        places: [],
      };
      entry.places.push({ loc: r.loc, place: placeOf(r.loc), kinds: [...new Set(fs.map((f) => KIND_LABEL[f.kind]))] });
      byId.set(r.knowledge_id, entry);
    }
    const log = (
      await c.query<{ id: string; scope: string; knowledge_id: string | null; legal_basis: keyof typeof LEGAL_BASIS_TITLE; request_ref: string; places: number; rows_changed: number; created_at: Date; actor: string | null }>(
        `SELECT r.id, r.scope, r.knowledge_id, r.legal_basis, r.request_ref, jsonb_array_length(r.targets) AS places, r.rows_changed, r.created_at, e.display_name AS actor
           FROM knowledge_redactions r LEFT JOIN employees e ON e.membership_id = r.actor_membership_id ORDER BY r.created_at DESC`,
      )
    ).rows;
    return {
      scanned: rows.length,
      findings: [...byId.values()],
      log: log.map((l) => ({
        id: l.id,
        scope: l.scope === 'person' ? 'обезличивание сотрудника' : 'удаление сведений',
        basis: LEGAL_BASIS_TITLE[l.legal_basis],
        ref: l.request_ref,
        places: l.places,
        rowsChanged: l.rows_changed,
        actor: l.actor,
        at: l.created_at.toISOString(),
      })),
      bases: LEGAL_BASES.map((b) => ({ id: b, title: LEGAL_BASIS_TITLE[b] })),
      note: 'Проверка по шаблонам (почта, телефоны, ИИН и другие длинные номера, документы, адреса, здоровье, зарплата, дисциплинарные сведения, фамилии сотрудников, пометки о конфиденциальности). Это не AI: проверяет человек.',
    };
  });
}

/** The request reference goes into the permanent log: it must carry no personal data and nothing that is being erased. */
async function assertCleanRef(c: Client, ref: string, erased: string[]) {
  const people = await orgPeople(c);
  const fs = findSensitive(ref, { people });
  if (fs.length) throw new AppError('validation_failed', `Номер основания попадёт в постоянный журнал — в нём не должно быть персональных данных (${kindsText(fs)}). Укажите только номер обращения или документа.`);
  const words = (s: string) => new Set((s.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]{4,}/gu) ?? []));
  const refWords = words(ref);
  for (const body of erased) {
    for (const f of findSensitive(body, { people })) {
      for (const w of words(f.value)) if (refWords.has(w)) throw new AppError('validation_failed', 'Номер основания повторяет удаляемые сведения. Укажите только номер обращения или документа.');
    }
  }
}

export const EraseInput = z
  .object({ basis: z.enum(LEGAL_BASES), ref: z.string().trim().min(3).max(80), places: z.array(LocSchema).min(1).max(100) })
  .strict();

export async function erase(db: Database, actor: OrgActor, id: string, input: z.infer<typeof EraseInput>) {
  if (!isAdmin(actor)) throw forbidden('Персональные данные в знаниях удаляет только администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    const all = (await material(c)).filter((r) => r.knowledge_id === id);
    if (!all.length) throw notFound('Знание не найдено');
    const same = (a: Loc, b: Loc) => JSON.stringify(a) === JSON.stringify(b);
    const targeted = all.filter((r) => input.places.some((p) => same(p as Loc, r.loc)));
    await assertCleanRef(c, input.ref, targeted.map((r) => r.body));
    const { rows } = await db_(() => c.query<{ n: number }>('SELECT app_knowledge_erase($1, $2, $3, $4::jsonb) AS n', [id, input.basis, input.ref, JSON.stringify(input.places)]));
    // The audit trail of the platform gets the fact only: no basis text, no reference, no places' content.
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'knowledge.personal_data_erased', entityType: 'knowledge', entityId: id, data: { places: input.places.length } });
    return { rowsChanged: rows[0]!.n, places: input.places.length };
  });
}

export const PseudonymizeInput = z.object({ basis: z.enum(LEGAL_BASES), ref: z.string().trim().min(3).max(80) }).strict();

export async function pseudonymize(db: Database, actor: OrgActor, membershipId: string, input: z.infer<typeof PseudonymizeInput>) {
  if (!isAdmin(actor)) throw forbidden('Обезличивает сотрудника в знаниях только администратор организации');
  return withTx(db, orgTx(actor), async (c) => {
    const who = (await c.query<{ name: string }>('SELECT display_name AS name FROM employees WHERE organization_id = app_org_id() AND membership_id = $1', [membershipId])).rows[0];
    if (!who) throw notFound('Сотрудник не найден');
    // Text places that name this person are erased in the same step.
    const targets: (Loc & { k: string })[] = [];
    for (const r of await material(c)) {
      if (r.body && !ERASED.test(r.body) && findSensitive(r.body, { people: [who.name] }).some((f) => f.kind === ('person' satisfies SensitiveKind))) targets.push({ ...r.loc, k: r.knowledge_id });
    }
    await assertCleanRef(c, input.ref, [who.name]);
    const { rows } = await db_(() => c.query<{ n: number }>('SELECT app_knowledge_pseudonymize($1, $2, $3, $4::jsonb) AS n', [membershipId, input.basis, input.ref, JSON.stringify(targets)]));
    await audit(c, { orgId: actor.orgId, actorUserId: actor.userId, action: 'knowledge.person_pseudonymized', entityType: 'membership', entityId: membershipId, data: { places: targets.length } });
    return { rowsChanged: rows[0]!.n, textPlaces: targets.length };
  });
}

/** The ledger: the log without any content, to keep outside database backups. */
export async function exportLedger(db: Database) {
  const { rows } = await db.pool.query(
    `SELECT id, organization_id, scope, knowledge_id, subject_membership_id, legal_basis, request_ref, targets, rows_changed, actor_membership_id, created_at
       FROM knowledge_redactions ORDER BY created_at`,
  );
  return { kind: 'modus-flow-erasure-ledger', version: 1, exportedAt: new Date().toISOString(), knowledgeRedactions: rows };
}

/** After a restore: bring back log rows the backup lacked, then re-apply every erasure. Schema owner only. */
export async function importLedger(db: Database, ledger: { kind: string; knowledgeRedactions: Record<string, unknown>[] }) {
  if (ledger.kind !== 'modus-flow-erasure-ledger') throw new Error('not an erasure ledger');
  let added = 0;
  for (const r of ledger.knowledgeRedactions) {
    const res = await db.pool.query(
      `INSERT INTO knowledge_redactions (id, organization_id, scope, knowledge_id, subject_membership_id, legal_basis, request_ref, targets, rows_changed, actor_membership_id, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
        WHERE EXISTS (SELECT 1 FROM organizations o WHERE o.id = $2)
          AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM knowledge_items x WHERE x.id = $4))
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.organization_id, r.scope, r.knowledge_id, r.subject_membership_id, r.legal_basis, r.request_ref, JSON.stringify(r.targets), r.rows_changed, r.actor_membership_id, r.created_at],
    );
    added += res.rowCount ?? 0;
  }
  const { rows } = await db.pool.query<{ n: number }>('SELECT app_knowledge_reapply_erasures() AS n');
  return { added, reapplied: rows[0]!.n };
}
