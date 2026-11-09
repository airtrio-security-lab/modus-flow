import { createHash } from 'node:crypto';
import { AppError } from '../domain/errors.ts';
import type { Client } from '../db/pool.ts';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/**
 * Executes a critical operation at most once per (user, scope, key), inside the
 * caller's transaction. The stored response is written in the same transaction
 * as the operation's effects, so either both exist or neither does.
 * Concurrent requests with the same key are serialized by an advisory lock.
 */
export async function idempotent<T>(
  c: Client,
  userId: string,
  scope: string,
  key: string | undefined,
  requestHash: string,
  op: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (key === undefined) return { ...(await op()), replayed: false };
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new AppError('validation_failed', 'Idempotency-Key: 8–128 символов [A-Za-z0-9_-]');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${userId}:${scope}:${key}`]);
  const existing = await c.query<{ request_hash: string; status_code: number; response: T }>(
    'SELECT request_hash, status_code, response FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3',
    [userId, scope, key],
  );
  const row = existing.rows[0];
  if (row) {
    if (row.request_hash !== requestHash) {
      throw new AppError('idempotency_mismatch', 'Этот Idempotency-Key уже использован с другими данными');
    }
    return { status: row.status_code, body: row.response, replayed: true };
  }
  const result = await op();
  await c.query(
    `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, scope, key, requestHash, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
