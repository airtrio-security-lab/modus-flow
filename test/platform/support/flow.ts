import type { Database } from '../../../platform/db/pool.ts';
import { createDraft, publishDraft } from '../../../platform/modules/lab.ts';
import * as wf from '../../../platform/modules/workflow.ts';
import { getIdea } from '../../../platform/modules/ideas.ts';
import { fullDraft, type world } from './db.ts';

type World = Awaited<ReturnType<typeof world>>;

let counter = 0;

/** Publishes a fresh idea by the author and returns its number. */
export async function publishIdea(db: Database, w: World, title = `Идея ${++counter}`): Promise<number> {
  const d = await createDraft(db, w.author.userId, { ...fullDraft, title });
  return (await publishDraft(db, w.author.userId, d.id, { organization: 'acme' })).body.idea.number;
}

/** Published + maintainer and decision owner assigned → stage "review". */
export async function ideaInReview(db: Database, w: World, title?: string): Promise<number> {
  const n = await publishIdea(db, w, title);
  await wf.assign(db, w.maintainer.actor, n, { maintainer: w.maintainer.membershipId, decisionOwner: w.decider.membershipId });
  return n;
}

/** In review with a running verification owned by the colleague. Returns idea number and verification id. */
export async function ideaInVerification(db: Database, w: World, title?: string): Promise<{ n: number; v: string }> {
  const n = await ideaInReview(db, w, title);
  const v = await wf.startVerification(db, w.maintainer.actor, n, {
    plan: 'Две недели на рампе №2, замер времени ожидания',
    successCriteria: 'Среднее ожидание меньше 40 минут',
    owner: w.colleague.membershipId,
  });
  return { n, v: v.body.id };
}

export const revisionText = {
  title: 'Слоты разгрузки (версия 2)',
  problem: 'Утром у рампы скапливаются фуры, водители ждут разгрузки около двух часов',
  proposal: 'Слоты по 30 минут с записью, плюс резервный слот для опоздавших поставщиков',
  successCriteria: 'Среднее ожидание меньше 40 минут в течение двух недель',
};

export const idea = getIdea;
