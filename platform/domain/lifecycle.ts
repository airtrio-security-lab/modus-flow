import { AppError } from './errors.ts';
import type { IdeaStage } from './model.ts';

/**
 * Idea lifecycle (organization side). "Private draft" is not a stage: drafts
 * live in the Personal Lab and become ideas only through explicit publication.
 *
 *   published → review → development ⇄ review   (a change request sends the idea to development)
 *                     ↘ verification → decision → adoption → impact_verification → closed
 *   any open stage → closed (reject / close decision, always with rationale)
 *
 * Review threads, verification runs, decisions and impact results keep their
 * own state in their own records; the stage only says where the idea is.
 */
const TRANSITIONS: Readonly<Record<IdeaStage, readonly IdeaStage[]>> = {
  published: ['review', 'development', 'closed'],
  review: ['development', 'verification', 'decision', 'closed'],
  development: ['review', 'closed'],
  verification: ['review', 'development', 'decision', 'closed'],
  decision: ['review', 'development', 'adoption', 'closed'],
  adoption: ['impact_verification', 'closed'],
  impact_verification: ['closed'],
  closed: [],
};

export function canMoveStage(from: IdeaStage, to: IdeaStage): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertStageTransition(from: IdeaStage, to: IdeaStage): void {
  if (!canMoveStage(from, to)) {
    throw new AppError('invalid_transition', `Переход ${from} → ${to} не допускается`, { from, to });
  }
}

export function nextStages(from: IdeaStage): readonly IdeaStage[] {
  return TRANSITIONS[from];
}

export const isOpen = (stage: IdeaStage) => stage !== 'closed';
