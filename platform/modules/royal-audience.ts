import { withTx, type Client, type Database } from '../db/pool.ts';
import { conflict, forbidden, notFound } from '../domain/errors.ts';
import type { OrgActor } from '../domain/model.ts';
import { audit } from './audit.ts';
import { orgTx } from './context.ts';
import { loadIdea } from './ideas.ts';

/**
 * An envoy audience is a real ceremony around an existing idea.
 * It is NOT approval, a workflow transition, a meeting, or a source of XP.
 * Only the originator can request it. Only the appointed king can accept.
 * Follow-up actions use the already-authorized workflow and meeting APIs.
 */

type King = { membershipId: string; name: string };
type AudienceRow = {
  id: string;
  idea_id: string;
  requester_membership_id: string;
  king_membership_id: string;
  requested_at: Date;
  accepted_at: Date | null;
  number: number;
  title: string;
  stage: string;
  author_membership_id: string;
  raised_by_membership_id: string | null;
  decision_owner_membership_id: string | null;
  requester_name: string;
};

async function currentKing(c: Client): Promise<King | null> {
  const { rows } = await c.query<{ membership_id: string; display_name: string }>(
    `SELECT g.membership_id, u.display_name
       FROM game_titles g
       JOIN memberships m ON m.organization_id = g.organization_id AND m.id = g.membership_id
       JOIN users u ON u.id = m.user_id
      WHERE g.organization_id = app_org_id() AND g.rank = 'king'
        AND m.status = 'active' AND m.access = 'member'
      LIMIT 1`,
  );
  return rows[0] ? { membershipId: rows[0].membership_id, name: rows[0].display_name } : null;
}

export interface Audience {
  id: string;
  ideaNumber: number;
  title: string;
  requesterName: string;
  role: 'sender' | 'king';
  status: 'requested' | 'accepted';
  requestedAt: string;
  acceptedAt: string | null;
  canDecide: boolean;
  canConvene: boolean;
  canReview: boolean;
}

export interface AudienceInbox {
  king: King | null;
  items: Audience[];
}

export async function listAudiences(db: Database, actor: OrgActor): Promise<AudienceInbox> {
  return withTx(db, orgTx(actor), async (c) => {
    if (actor.access !== 'member') return { king: null, items: [] };
    const king = await currentKing(c);
    const { rows } = await c.query<AudienceRow>(
      `SELECT a.id, a.idea_id, a.requester_membership_id, a.king_membership_id,
              a.requested_at, a.accepted_at, i.number,
              r.title, i.stage, i.author_membership_id, i.raised_by_membership_id,
              i.decision_owner_membership_id, u.display_name AS requester_name
         FROM royal_audiences a
         JOIN ideas i ON i.id = a.idea_id AND i.organization_id = a.organization_id
         JOIN idea_revisions r ON r.idea_id = i.id AND r.number = i.current_revision_number
         JOIN memberships m ON m.id = a.requester_membership_id AND m.organization_id = a.organization_id
         JOIN users u ON u.id = m.user_id
        WHERE a.organization_id = app_org_id()
          AND (a.requester_membership_id = app_membership_id() OR a.king_membership_id = app_membership_id())
        ORDER BY a.requested_at DESC, a.id DESC
        LIMIT 100`,
    );
    return {
      king,
      items: rows.map((r): Audience => {
        const forKing = r.king_membership_id === actor.membershipId;
        const isCurrentKing = forKing && king?.membershipId === actor.membershipId;
        const allowed =
          isCurrentKing &&
          r.accepted_at !== null &&
          (r.stage === 'review' || r.stage === 'decision') &&
          r.decision_owner_membership_id === actor.membershipId &&
          r.author_membership_id !== actor.membershipId &&
          r.raised_by_membership_id !== actor.membershipId;
        return {
          id: r.id,
          ideaNumber: r.number,
          title: r.title,
          requesterName: r.requester_name,
          role: forKing ? 'king' : 'sender',
          status: r.accepted_at ? 'accepted' : 'requested',
          requestedAt: r.requested_at.toISOString(),
          acceptedAt: r.accepted_at?.toISOString() ?? null,
          canDecide: allowed,
          canReview: isCurrentKing && r.accepted_at !== null && r.stage !== 'closed',
          canConvene: isCurrentKing && r.accepted_at !== null && actor.roles.some((role) => ['org_admin', 'maintainer', 'decision_owner'].includes(role)),
        };
      }),
    };
  });
}

/** Return the existing request on replay; the (idea, requester) unique index forbids spam. */
export async function requestAudience(db: Database, actor: OrgActor, number: number) {
  return withTx(db, orgTx(actor), async (c) => {
    if (actor.access !== 'member') throw forbidden('Аудиенцию может запросить сотрудник организации');
    const idea = await loadIdea(c, number, true);
    if (![idea.author_membership_id, idea.raised_by_membership_id].includes(actor.membershipId)) {
      throw forbidden('Посла отправляет только автор или инициатор обращения');
    }
    const previous = await c.query<{ id: string; accepted_at: Date | null }>(
      'SELECT id, accepted_at FROM royal_audiences WHERE idea_id = $1 AND requester_membership_id = $2',
      [idea.id, actor.membershipId],
    );
    if (previous.rows[0]) {
      return { id: previous.rows[0].id, accepted: !!previous.rows[0].accepted_at, replayed: true };
    }
    if (idea.stage === 'closed') throw conflict('По завершённому обращению аудиенцию запросить нельзя');

    const king = await currentKing(c);
    if (!king) throw conflict('В этой организации ещё не назначен Король');
    if (king.membershipId === actor.membershipId) throw conflict('Нельзя отправить посла самому себе');

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO royal_audiences (organization_id, idea_id, requester_membership_id, king_membership_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [actor.orgId, idea.id, actor.membershipId, king.membershipId],
    );
    const id = rows[0]!.id;
    await audit(c, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'royal_audience.requested',
      entityType: 'idea',
      entityId: idea.id,
      data: { audienceId: id, kingMembershipId: king.membershipId },
    });
    return { id, accepted: false, replayed: false };
  });
}

/** Accepting is a ceremonial acknowledgement: it does not change the idea status. */
export async function acceptAudience(db: Database, actor: OrgActor, id: string) {
  return withTx(db, orgTx(actor), async (c) => {
    if (actor.access !== 'member') throw forbidden();
    const { rows } = await c.query<{ idea_id: string; king_membership_id: string; accepted_at: Date | null }>(
      'SELECT idea_id, king_membership_id, accepted_at FROM royal_audiences WHERE id = $1 AND organization_id = app_org_id() FOR UPDATE',
      [id],
    );
    const a = rows[0];
    if (!a) throw notFound('Аудиенция не найдена');
    if (a.king_membership_id !== actor.membershipId) throw forbidden('Аудиенцию принимает только назначенный Король');
    if (a.accepted_at) return { id, acceptedAt: a.accepted_at.toISOString(), replayed: true };
    const king = await currentKing(c);
    if (!king || king.membershipId !== actor.membershipId) {
      throw forbidden('Получатель больше не назначен Королём');
    }
    const { rows: updated } = await c.query<{ accepted_at: Date }>(
      `UPDATE royal_audiences SET accepted_at = clock_timestamp(),
           accepted_by_membership_id = $2 WHERE id = $1
       RETURNING accepted_at`,
      [id, actor.membershipId],
    );
    await audit(c, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'royal_audience.accepted',
      entityType: 'idea',
      entityId: a.idea_id,
      data: { audienceId: id },
    });
    return { id, acceptedAt: updated[0]!.accepted_at.toISOString(), replayed: false };
  });
}
