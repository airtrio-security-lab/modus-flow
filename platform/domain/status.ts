/**
 * Author-facing status. Computed by the database view `idea_overview`
 * (migration 0004) from the lifecycle stage and records; this module gives
 * the labels and the three phases the owner named: «в разработке»,
 * «принятие решения», «реализация».
 */
export const ITEM_STATUSES = [
  'unrouted',
  'in_review',
  'needs_info',
  'in_verification',
  'decision',
  'in_progress',
  'implemented',
  'rejected',
  'closed',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type OwnerPhase = 'registered' | 'development' | 'decision' | 'implementation' | 'done';

export const STATUS_INFO: Record<ItemStatus, { label: string; phase: OwnerPhase; open: boolean; hint: string }> = {
  unrouted: { label: 'Ждёт распределения', phase: 'registered', open: true, hint: 'Ответственный ещё не назначен — обращение в общей очереди руководителей' },
  in_review: { label: 'На рассмотрении', phase: 'development', open: true, hint: 'Ответственный изучает обращение' },
  needs_info: { label: 'Нужны уточнения', phase: 'development', open: true, hint: 'Ответственный задал вопрос автору' },
  in_verification: { label: 'Проверка на практике', phase: 'development', open: true, hint: 'Идёт пилот: собираются результаты' },
  decision: { label: 'Принятие решения', phase: 'decision', open: true, hint: 'Ответственный за решение готовит вывод' },
  in_progress: { label: 'В реализации', phase: 'implementation', open: true, hint: 'Решение принято, исполнитель внедряет' },
  implemented: { label: 'Реализовано', phase: 'done', open: false, hint: 'Изменение внедрено' },
  rejected: { label: 'Отклонено', phase: 'done', open: false, hint: 'Отклонено с объяснением причин' },
  closed: { label: 'Закрыто', phase: 'done', open: false, hint: 'Закрыто с объяснением (например, дубликат)' },
};

export const CHANNEL_LABELS = {
  app: 'Приложение',
  meeting: 'Совещание',
  email: 'Почта',
  phone: 'Звонок',
  conversation: 'Устно',
  other: 'Другое',
} as const;
