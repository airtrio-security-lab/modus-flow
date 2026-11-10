import type { Database } from '../../../platform/db/pool.ts';
import * as admin from '../../../platform/modules/admin.ts';
import { submitItem, type SubmitInputT } from '../../../platform/modules/intake.ts';
import { person, type world } from './db.ts';

type World = Awaited<ReturnType<typeof world>>;

/**
 * Fictional organization structure for the feedback MVP tests (no real people):
 *  - «Склад» headed by a person holding both lead roles (hybrid powers);
 *  - «Сервис» without a head;
 *  - category «ИТ и инструменты» routed to maintainer + decision owner (4 h SLA);
 *  - categories «Логистика» and «Охрана труда» without rules.
 */
export async function feedbackOrg(db: Database, w: World) {
  const head = await person(db, w.acmeId, 'Начальник Склада', ['employee', 'maintainer', 'decision_owner'], 'Склад');
  const escalation = await person(db, w.acmeId, 'Собственник Демо', ['employee', 'decision_owner', 'org_admin'], 'Руководство');
  const sklad = (await admin.createDepartment(db, w.admin.actor, { name: 'Склад', head: head.membershipId })).id;
  const service = (await admin.createDepartment(db, w.admin.actor, { name: 'Сервис' })).id;
  const it = (await admin.createCategory(db, w.admin.actor, { name: 'ИТ и инструменты' })).id;
  const logistics = (await admin.createCategory(db, w.admin.actor, { name: 'Логистика' })).id;
  const safety = (await admin.createCategory(db, w.admin.actor, { name: 'Охрана труда' })).id;
  const itRule = (
    await admin.createRule(db, w.admin.actor, {
      categoryId: it,
      maintainer: w.maintainer.membershipId,
      decisionOwner: w.decider.membershipId,
      firstResponseHours: 4,
      resolutionDays: 5,
    })
  ).id;
  await admin.updateSettings(db, w.admin.actor, { escalationMembershipId: escalation.membershipId });
  return { head, escalation, departments: { sklad, service }, categories: { it, logistics, safety }, rules: { it: itRule } };
}

export const problemText = 'Сканеры на складе зависают при приёмке, приходится вводить коды вручную';

export const submit = (db: Database, who: { actor: World['author']['actor'] }, input: Partial<SubmitInputT> & Pick<SubmitInputT, 'title'>, key?: string) =>
  submitItem(
    db,
    who.actor,
    {
      kind: 'problem',
      problem: problemText,
      sourceChannel: 'app',
      ...input,
    } as SubmitInputT,
    key,
  );
