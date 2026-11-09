import { z } from 'zod';
import { AppError } from './errors.ts';

/**
 * Personal Lab content. The six guided-reflection steps are kept compatible
 * with the prototype (PR #4/#5): observation, cause, evidence, proposal,
 * risks, pilot. Only three of them ever leave the Lab, and only through an
 * explicit publication: observation → problem, proposal → proposal,
 * pilot → success criteria. cause / evidence / risks / notes stay private.
 * There is no AI dialogue storage yet; when added it stays in the Lab too.
 */
export const LAB_STEPS = ['observation', 'cause', 'evidence', 'proposal', 'risks', 'pilot'] as const;
export const PUBLISHED_STEPS = ['observation', 'proposal', 'pilot'] as const;

const stepText = z.string().trim().min(1).max(5000);

export const LabContentSchema = z
  .object({
    observation: stepText.optional(),
    cause: stepText.optional(),
    evidence: stepText.optional(),
    proposal: stepText.optional(),
    risks: stepText.optional(),
    pilot: z.string().trim().min(1).max(3000).optional(),
    notes: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

export type LabContent = z.infer<typeof LabContentSchema>;

export interface PublicationSnapshot {
  title: string;
  problem: string;
  proposal: string;
  successCriteria: string | null;
}

/** Builds the organization-visible snapshot. Private steps are never read. */
export function projectPublication(title: string, content: LabContent): PublicationSnapshot {
  if (!content.observation || !content.proposal) {
    throw new AppError('validation_failed', 'Для публикации нужны наблюдение и предложение', {
      missing: [!content.observation && 'observation', !content.proposal && 'proposal'].filter(Boolean),
    });
  }
  return {
    title: title.trim(),
    problem: content.observation,
    proposal: content.proposal,
    successCriteria: content.pilot ?? null,
  };
}
