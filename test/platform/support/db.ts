import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDatabase, withAdminTx, type Database } from '../../../platform/db/pool.ts';
import { migrate } from '../../../platform/db/migrate.ts';
import { addMember, createOrganization, createUser } from '../../../platform/modules/provisioning.ts';
import type { OrgActor, OrgRole } from '../../../platform/domain/model.ts';

/**
 * Integration tests run against a real PostgreSQL. TEST_DATABASE_URL must
 * point at a server where the user may CREATE DATABASE (each test file gets
 * its own throwaway database). Tests fail loudly when it is missing — they
 * are never silently skipped.
 */
export async function freshDatabase(): Promise<{ db: Database; drop: () => Promise<void> }> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) throw new Error('TEST_DATABASE_URL is not set (see README: "Platform tests")');
  const name = `modus_t_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client({ connectionString: admin });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString(), 12);
  await migrate(db);
  return {
    db,
    drop: async () => {
      await db.close();
      const r = new pg.Client({ connectionString: admin });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await r.end();
    },
  };
}

export interface Person {
  userId: string;
  membershipId: string;
  actor: OrgActor;
}

async function person(db: Database, orgId: string, name: string, roles: OrgRole[], department: string): Promise<Person> {
  const userId = await createUser(db, name);
  const membershipId = await addMember(db, orgId, userId, roles, { department });
  return { userId, membershipId, actor: { userId, orgId, membershipId, roles } };
}

/** Two fictional organizations with distinct people. No real personal data. */
export async function world(db: Database) {
  const acmeId = await createOrganization(db, 'acme', 'Acme Demo');
  const betaId = await createOrganization(db, 'beta', 'Beta Demo');
  return {
    acmeId,
    betaId,
    author: await person(db, acmeId, 'Кирилл Демо', ['employee'], 'Склад'),
    colleague: await person(db, acmeId, 'Анна Коллега', ['employee'], 'Склад'),
    maintainer: await person(db, acmeId, 'Мария Ведущая', ['employee', 'maintainer'], 'Логистика'),
    decider: await person(db, acmeId, 'Олжас Решающий', ['employee', 'decision_owner'], 'Операции'),
    admin: await person(db, acmeId, 'Админ Демо', ['employee', 'org_admin'], 'ИТ'),
    outsider: await person(db, betaId, 'Бета Сотрудник', ['employee', 'maintainer'], 'Бета'),
  };
}

/** Raw query as the owner (bypasses RLS) — for asserting stored state only. */
export const ownerQuery = <T extends pg.QueryResultRow>(db: Database, sql: string, params: unknown[] = []) =>
  withAdminTx(db, async (c) => (await c.query<T>(sql, params)).rows);

export const fullDraft = {
  kind: 'idea' as const,
  title: 'Слоты разгрузки для поставщиков',
  content: {
    observation: 'Утром у рампы скапливаются фуры, водители ждут по два часа',
    cause: 'ЛИЧНОЕ: подозреваю, что смена начинается слишком поздно',
    evidence: 'ЛИЧНОЕ: сам считал машины три дня',
    proposal: 'Ввести слоты разгрузки по 30 минут с предварительной записью',
    risks: 'ЛИЧНОЕ: начальник смены может быть против',
    pilot: 'Две недели на одной рампе; среднее ожидание меньше 40 минут',
    notes: 'ЛИЧНОЕ: обсудить с ИИ позже',
  },
};
