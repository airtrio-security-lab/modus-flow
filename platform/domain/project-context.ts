import { z } from 'zod';

/**
 * «Где возникла проблема?» (ADR-0031): an optional note on an item — the project or site, the stage of
 * work and the other departments it touches. It is context for the people who decide, not a project
 * register: no budgets, contracts or schedules, and no rights for anybody.
 *
 * Two things are kept apart on purpose: `ideas.department_id` is the department responsible for
 * routing; the affected departments are only named here and get nothing from it.
 */
export const WORK_STAGES = ['design', 'procurement', 'installation', 'commissioning', 'operation', 'internal', 'other'] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
export const WORK_STAGE_NAMES: Record<WorkStage, string> = {
  design: 'Проектирование',
  procurement: 'Закупки и поставка',
  installation: 'Монтаж',
  commissioning: 'Пусконаладка',
  operation: 'Эксплуатация',
  internal: 'Внутренние процессы',
  other: 'Другое',
};

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const ContextFields = {
  project: text(1, 160).optional(),
  workStage: z.enum(WORK_STAGES).optional(),
  affectedDepartmentIds: z.array(z.uuid()).max(8).optional(),
};
export const ContextInput = z
  .object(ContextFields)
  .strict()
  .refine((v) => v.project || v.workStage || v.affectedDepartmentIds?.length, { message: 'Укажите проект, этап работы или затронутое подразделение' });
export type ContextInputT = z.infer<typeof ContextInput>;
export const AffectedInput = z.object({ departmentId: z.uuid() }).strict();
