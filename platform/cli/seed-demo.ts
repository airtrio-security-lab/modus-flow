import { createDatabase } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { assertSecret, issueToken } from '../http/auth.ts';
import { addMember, createOrganization, createUser } from '../modules/provisioning.ts';

/**
 * Creates a demo organization with FICTIONAL people (no real employee data)
 * and prints short-lived tokens for local testing. Refuses to run twice.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const secret = assertSecret(process.env.MODUS_AUTH_SECRET);
const db = createDatabase(url, 2);
try {
  await migrate(db);
  const org = await createOrganization(db, 'demo-trade', 'Demo Trade (вымышленная организация)');
  const people = [
    { name: 'Кирилл Демо', roles: ['employee'] as const, department: 'Склад' },
    { name: 'Мария Пример', roles: ['employee', 'maintainer'] as const, department: 'Логистика' },
    { name: 'Олжас Тестов', roles: ['employee', 'decision_owner'] as const, department: 'Операции' },
    { name: 'Админ Демо', roles: ['employee', 'org_admin'] as const, department: 'ИТ' },
  ];
  const out: Record<string, { userId: string; token: string }> = {};
  for (const p of people) {
    const userId = await createUser(db, p.name);
    await addMember(db, org, userId, [...p.roles], { department: p.department });
    out[p.name] = { userId, token: issueToken(secret, userId, 8 * 3600) };
  }
  console.log(JSON.stringify({ organization: 'demo-trade', people: out }, null, 2));
} finally {
  await db.close();
}
