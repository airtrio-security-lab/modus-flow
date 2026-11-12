import { z } from 'zod';
import { AppError, conflict, forbidden } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { withTx, type Client, type Database } from '../db/pool.ts';
import { orgTx } from './context.ts';
import { hashRequest, idempotent } from './idempotency.ts';
import { loadIdea } from './ideas.ts';

/**
 * «Отложить решение» (0018). The person who decides the item may postpone it until a date with a reason
 * the author reads; the resolution deadline is paused for that time. A game title gives no right here.
 * The database function checks the right and moves the deadline; this module only maps the outcome
 * to the product's errors and tells the people of the item.
 */
export const DeferInput = z
  .object({
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД'),
    reason: z.string().trim().min(10, 'Объясните автору, почему решение откладывается (от 10 символов)').max(1000),
  })
  .strict();

export interface Deferral {
  id: string;
  until: string;
  reason: string;
  by: string | null;
  at: string;
}

/** The running postponement of an item, if any. */
export async function activeDeferral(c: Client, ideaId: string): Promise<Deferral | null> {
  const { rows } = await c.query<{ id: string; until: string; reason: string; by: string | null; at: Date }>(
    `SELECT d.id, to_char(d.until_date, 'YYYY-MM-DD') AS until, d.reason, e.display_name AS by, d.deferred_at AS at
       FROM idea_deferrals d LEFT JOIN employees e ON e.membership_id = d.deferred_by_membership_id
      WHERE d.idea_id = $1 AND d.resumed_at IS NULL AND d.until_date >= current_date`,
    [ideaId],
  );
  const r = rows[0];
  return r ? { id: r.id, until: r.until, reason: r.reason, by: r.by, at: r.at.toISOString() } : null;
}

export async function defer(db: Database, actor: OrgActor, number: number, input: z.infer<typeof DeferInput>, key?: string) {
  if (actor.access !== 'member') throw forbidden('Отложить решение может ответственный за решение по обращению');
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `idea.defer:${idea.id}`, key, hashRequest(input), async () => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>('SELECT app_defer_idea($1, $2::date, $3) AS id', [idea.id, input.until, input.reason])).rows[0]!.id;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '42501') throw forbidden('Отложить решение может только ответственный за решение по этому обращению');
        if (code === '23505') throw conflict('Решение по обращению уже отложено');
        if (code === '23514') throw new AppError('conflict', 'Отложить можно только обращение, по которому ещё ждут решения');
        if (code === '22023' || code === '22008' || code === '22007') throw new AppError('validation_failed', 'Выберите дату от завтрашнего дня до 180 дней вперёд');
        throw e;
      }
      await c.query('SELECT app_notify_deferral($1)', [id]);
      return { status: 201, body: { deferral: await activeDeferral(c, idea.id) } };
    });
  });
}

export async function resume(db: Database, actor: OrgActor, number: number, key?: string) {
  if (actor.access !== 'member') throw forbidden('Вернуть обращение в работу может ответственный за решение');
  return withTx(db, orgTx(actor), async (c) => {
    const idea = await loadIdea(c, number, true);
    return idempotent(c, actor.userId, `idea.resume:${idea.id}`, key, hashRequest({}), async () => {
      try {
        await c.query('SELECT app_resume_idea($1)', [idea.id]);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '42501') throw forbidden('Вернуть обращение в работу может только ответственный за решение по нему');
        if (code === '23514') throw new AppError('conflict', 'Обращение не отложено');
        throw e;
      }
      return { status: 200, body: { deferral: null } };
    });
  });
}
