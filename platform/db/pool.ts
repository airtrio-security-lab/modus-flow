import pg from 'pg';
import { AppError } from '../domain/errors.ts';

export type Client = pg.PoolClient;

export interface Database {
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Identity of the caller for one transaction. Never taken from client input directly. */
export interface TxIdentity {
  userId: string;
  orgId?: string;
  membershipId?: string;
}

export const APP_ROLE = 'modus_app';

export function createDatabase(connectionString: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString, max });
  return { pool, close: () => pool.end() };
}

/**
 * Runs `fn` in one transaction as the restricted application role with the
 * caller's identity bound for Row Level Security. Every request-scoped write
 * goes through here, so tenant isolation is enforced by PostgreSQL even if a
 * service forgets a WHERE clause.
 */
export async function withTx<T>(db: Database, who: TxIdentity, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.org_id', $2, true),
              set_config('app.membership_id', $3, true)`,
      [who.userId, who.orgId ?? '', who.membershipId ?? ''],
    );
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw translatePgError(error);
  } finally {
    client.release();
  }
}

/**
 * Privileged transaction for provisioning (organizations, users, memberships)
 * from operator CLIs and tests. Never reachable from HTTP handlers.
 */
export async function withAdminTx<T>(db: Database, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw translatePgError(error);
  } finally {
    client.release();
  }
}

interface PgErrorLike {
  code?: string;
  message?: string;
}

/** Maps database integrity errors to API errors without leaking SQL details. */
export function translatePgError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const e = error as PgErrorLike;
  const mapped = mapPgCode(e);
  if (mapped) mapped.cause = error; // keep the database error for server-side logs
  return mapped ?? error;
}

function mapPgCode(e: PgErrorLike): AppError | null {
  switch (e?.code) {
    case '23505':
      return new AppError('conflict', 'Запись уже существует');
    case '23503':
      // Includes cross-tenant references rejected by composite foreign keys.
      return new AppError('validation_failed', 'Ссылка на несуществующий или чужой объект');
    case '23514':
    case '23502':
    case '22P02':
      return new AppError('validation_failed', 'Данные нарушают ограничения модели');
    case '42501':
      return new AppError('forbidden', 'Операция запрещена политикой доступа');
    case 'P0001':
      return new AppError('conflict', 'История неизменяема');
    default:
      return null;
  }
}

/**
 * Refuses to serve requests over a connection that could escape Row Level
 * Security: a superuser, a role that owns the schema, or a login that cannot
 * assume modus_app. Inside a transaction `RESET ROLE` returns to the login
 * role, so the login role itself must be unprivileged (docs/adr/0002).
 */
export async function assertUnprivilegedConnection(db: Database): Promise<void> {
  const { rows } = await db.pool.query<{ superuser: boolean; owns: number; member: boolean; user: string }>(
    `SELECT r.rolsuper AS superuser, current_user AS user,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND pg_has_role(current_user, c.relowner, 'USAGE')) AS owns,
            pg_has_role(current_user, '${APP_ROLE}', 'MEMBER') AS member
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const r = rows[0]!;
  const problems = [
    r.superuser && 'is a superuser',
    r.owns > 0 && 'owns (or inherits ownership of) schema objects',
    !r.member && `is not a member of ${APP_ROLE}`,
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(`Database login role "${r.user}" ${problems.join(', ')}; use an unprivileged login role (see README)`);
  }
}
