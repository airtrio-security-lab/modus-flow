import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { withTx, type Database } from '../../platform/db/pool.ts';
import * as admin from '../../platform/modules/admin.ts';
import * as district from '../../platform/modules/district.ts';
import * as progress from '../../platform/modules/progress.ts';
import { getMe } from '../../platform/modules/context.ts';
import { kingdom } from '../../platform/modules/kingdom.ts';
import { REALM_DEFAULT_NAME } from '../../platform/domain/civilizations.ts';
import { freshDatabase, ownerQuery, person, world } from './support/db.ts';
import { feedbackOrg } from './support/feedback.ts';

/**
 * «Великое Содружество» (ADR-0021): one organization is one commonwealth in the game. Its name is a
 * setting of that organization; the real company name is untouched. Civilizations are styles of
 * departments — choosing them never creates organizations. Organizations stay isolated.
 */
let db: Database;
let drop: () => Promise<void>;
let w: Awaited<ReturnType<typeof world>>;
let f: Awaited<ReturnType<typeof feedbackOrg>>;

before(async () => {
  ({ db, drop } = await freshDatabase());
  w = await world(db);
  f = await feedbackOrg(db, w);
});
after(async () => drop());

const codes = (...c: string[]) => (e: { code?: string }) => c.includes(e.code ?? '');
const realmOf = async (userId: string, slug: string) => (await getMe(db, userId)).memberships.find((m) => m.organization === slug)!;

test('the game world is named by the organization; the real company name stays for administration', async () => {
  const before = await realmOf(w.author.actor.userId, 'acme');
  assert.deepEqual([before.organizationName, before.realmName], ['Acme Demo', REALM_DEFAULT_NAME]);
  // Only an admin renames it; validation applies.
  await assert.rejects(admin.updateSettings(db, w.author.actor, { realmName: 'Самозванное Содружество' }), codes('forbidden'));
  await assert.rejects(admin.updateSettings(db, w.admin.actor, { realmName: 'Аб' }));
  await admin.updateSettings(db, w.admin.actor, { realmName: 'Содружество Акме' });
  const afterRename = await realmOf(w.author.actor.userId, 'acme');
  assert.deepEqual([afterRename.organizationName, afterRename.realmName], ['Acme Demo', 'Содружество Акме']);
  assert.equal((await admin.getDirectory(db, w.admin.actor)).settings?.realmName, 'Содружество Акме');
  // An employee cannot write it directly either.
  const r = await withTx(db, { userId: w.author.actor.userId, orgId: w.acmeId, membershipId: w.author.membershipId }, (c) =>
    c.query(`UPDATE organizations SET realm_name = 'Взлом' WHERE id = $1`, [w.acmeId]),
  );
  assert.equal(r.rowCount, 0);
});

test('organizations are isolated: each has its own commonwealth, departments and styles', async () => {
  const betaAdmin = await person(db, w.betaId, 'Бета Админ', ['employee', 'org_admin'], 'Бета');
  await admin.updateSettings(db, betaAdmin.actor, { realmName: 'Содружество Бета' });
  assert.equal((await realmOf(w.author.actor.userId, 'acme')).realmName, 'Содружество Акме', 'another organization does not rename ours');
  assert.equal((await realmOf(w.outsider.actor.userId, 'beta')).realmName, 'Содружество Бета');
  assert.equal((await getMe(db, w.outsider.actor.userId)).memberships.some((m) => m.organization === 'acme'), false);
  const betaDept = (await admin.createDepartment(db, betaAdmin.actor, { name: 'Склад' })).id;
  await district.setCivilization(db, betaAdmin.actor, betaDept, 'mongolia');
  // A head or admin of one organization cannot touch another organization's district.
  await assert.rejects(district.setCivilization(db, w.admin.actor, betaDept, 'japan'), codes('forbidden', 'not_found'));
  await assert.rejects(district.district(db, w.outsider.actor, f.departments.sklad), codes('not_found'));
  const acme = (await kingdom(db, w.author.actor)).castles.map((c) => c.name).sort();
  assert.deepEqual(acme, ['Склад', 'Сервис'].sort());
});

test('civilizations are styles of departments, not organizations; XP and rights stay', async () => {
  const orgs = await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM organizations');
  const roles = await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id');
  const xp = (await progress.castle(db, f.head.actor, f.departments.sklad)).xp;
  for (const civ of ['japan', 'kazakh', 'camelot', 'mongolia']) await district.setCivilization(db, f.head.actor, f.departments.sklad, civ);
  await district.setCivilization(db, w.admin.actor, f.departments.service, 'camelot');
  assert.deepEqual(await ownerQuery<{ n: number }>(db, 'SELECT count(*)::int AS n FROM organizations'), orgs, 'no organizations are created for civilizations');
  assert.deepEqual(await ownerQuery(db, 'SELECT id, roles FROM memberships ORDER BY id'), roles);
  assert.equal((await progress.castle(db, f.head.actor, f.departments.sklad)).xp, xp);
  // Two departments of one organization may share a style and stay separate districts.
  const castles = (await kingdom(db, w.author.actor)).castles;
  assert.deepEqual(castles.map((c) => [c.name, c.civilization]).sort(), [['Склад', 'mongolia'], ['Сервис', 'camelot']].sort());
});
