import type { Client } from '../db/pool.ts';

export interface AuditEntry {
  orgId: string | null;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Identifiers and workflow facts only. Never put draft text or personal notes here. */
  data?: Record<string, unknown>;
}

export async function audit(c: Client, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.orgId, e.actorUserId, e.action, e.entityType, e.entityId, JSON.stringify(e.data ?? {})],
  );
}
