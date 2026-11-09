import { withTx, type Client, type Database } from '../db/pool.ts';
import type { NotificationEvent, OrgActor } from '../domain/model.ts';
import { orgTx } from './context.ts';

/**
 * Notifications Engine. Rules:
 *  - every notification has explicit recipients chosen by the workflow (no broadcast);
 *  - the actor never notifies themselves;
 *  - recipients' subscription settings are honoured;
 *  - rows hold no free text: messages are rendered at read time from the event
 *    type, the actor's name and the organization-visible idea title, so private
 *    Lab content can never travel through a notification;
 *  - (recipient, dedupe_key) is unique, so retries do not duplicate.
 * Delivery to external channels (e-mail, messengers) is a future outbox consumer.
 */
export async function notify(
  c: Client,
  actor: OrgActor,
  event: NotificationEvent,
  ideaId: string | null,
  recipients: Iterable<string | null | undefined>,
  dedupeSuffix: string,
): Promise<number> {
  const targets = [...new Set([...recipients].filter((r): r is string => !!r && r !== actor.membershipId))];
  if (targets.length === 0 || ideaId === null) return 0;
  // app_notify (migration 0003) is the only write path: it verifies that the
  // event is backed by a workflow record created by the actor and that every
  // recipient may see the idea. Direct INSERTs are not granted.
  const { rows } = await c.query<{ n: number }>('SELECT app_notify($1, $2, $3::uuid[], $4) AS n', [event, ideaId, targets, dedupeSuffix]);
  return rows[0]!.n;
}

/** Members holding any of the given roles (e.g. who triages newly published ideas). */
export async function membersWithRoles(c: Client, orgId: string, roles: readonly string[]): Promise<string[]> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM memberships
      WHERE organization_id = $1 AND status = 'active' AND access = 'member' AND roles && $2::text[]`,
    [orgId, roles],
  );
  return rows.map((r) => r.id);
}

const TEMPLATES: Record<NotificationEvent, (actor: string, title: string) => string> = {
  idea_published: (a, t) => `${a} предлагает на обсуждение новую идею «${t}»`,
  comment_added: (a, t) => `${a} оставляет комментарий к идее «${t}»`,
  changes_requested: (a, t) => `${a} просит доработать идею «${t}»`,
  assigned: (a, t) => `${a} назначает вас ответственным по идее «${t}»`,
  verification_started: (a, t) => `${a} запускает проверку идеи «${t}»`,
  verification_completed: (a, t) => `Проверка идеи «${t}» завершена (${a})`,
  idea_merged: (a, t) => `${a} принимает решение о внедрении идеи «${t}»`,
  idea_rejected: (a, t) => `${a} отклоняет идею «${t}» с объяснением`,
  contribution_confirmed: (a, t) => `${a} подтверждает ваш вклад в идею «${t}»`,
  honor_board_recognition: (_a, t) => `Ваш вклад в идею «${t}» отмечен на доске почёта`,
  objection_raised: (a, t) => `${a} возражает против замечания по идее «${t}»`,
  revision_submitted: (a, t) => `${a} публикует новую версию идеи «${t}»`,
  suggestion_submitted: (a, t) => `${a} предлагает свою версию идеи «${t}»`,
  suggestion_decided: (a, t) => `${a} рассматривает ваше предложение по идее «${t}»`,
};

export interface InboxItem {
  id: string;
  event: NotificationEvent;
  message: string;
  ideaNumber: number | null;
  createdAt: string;
  readAt: string | null;
}

export async function inbox(c: Client, limit = 50): Promise<InboxItem[]> {
  const { rows } = await c.query<{
    id: string;
    event_type: NotificationEvent;
    actor_name: string | null;
    title: string | null;
    number: number | null;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT n.id, n.event_type, u.display_name AS actor_name, r.title, i.number, n.created_at, n.read_at
       FROM notifications n
       LEFT JOIN memberships am ON am.id = n.actor_membership_id
       LEFT JOIN users u ON u.id = am.user_id
       LEFT JOIN ideas i ON i.id = n.idea_id
       LEFT JOIN idea_revisions r ON r.idea_id = i.id AND r.number = i.current_revision_number
      WHERE n.recipient_membership_id = app_membership_id()
      ORDER BY n.created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    event: r.event_type,
    message: TEMPLATES[r.event_type](r.actor_name ?? 'Система', r.title ?? '—'),
    ideaNumber: r.number,
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at?.toISOString() ?? null,
  }));
}

export const listInbox = (db: Database, actor: OrgActor) => withTx(db, orgTx(actor), (c) => inbox(c));

/** Marks notifications as read; RLS limits the update to the caller's own inbox. */
export async function markRead(db: Database, actor: OrgActor, ids: string[]): Promise<number> {
  return withTx(db, orgTx(actor), async (c) => {
    const { rowCount } = await c.query(
      'UPDATE notifications SET read_at = now() WHERE id = ANY($1::uuid[]) AND read_at IS NULL',
      [ids],
    );
    return rowCount ?? 0;
  });
}
