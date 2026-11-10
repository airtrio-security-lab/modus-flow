import type { Channel, Status } from './types';

/** Mirrors platform/domain/status.ts, plus the tone of the signal lamp. */
export type Tone = 'active' | 'wait' | 'done' | 'stop' | 'idle';
export type Phase = 0 | 1 | 2 | 3 | 4; // registered, development, decision, implementation, result

export const STATUS: Record<Status, { label: string; phase: Phase; tone: Tone; hint: string; open: boolean }> = {
  unrouted: { label: 'Ждёт распределения', phase: 0, tone: 'wait', open: true, hint: 'Ответственный ещё не назначен — обращение в общей очереди руководителей' },
  in_review: { label: 'На рассмотрении', phase: 1, tone: 'active', open: true, hint: 'Ответственный изучает обращение' },
  needs_info: { label: 'Нужны уточнения', phase: 1, tone: 'wait', open: true, hint: 'Ответственный задал вопрос автору' },
  in_verification: { label: 'Проверка на практике', phase: 1, tone: 'active', open: true, hint: 'Идёт пилот: собираются результаты' },
  decision: { label: 'Принятие решения', phase: 2, tone: 'active', open: true, hint: 'Ответственный за решение готовит вывод' },
  in_progress: { label: 'В реализации', phase: 3, tone: 'active', open: true, hint: 'Решение принято, исполнитель внедряет' },
  implemented: { label: 'Реализовано', phase: 4, tone: 'done', open: false, hint: 'Изменение внедрено' },
  rejected: { label: 'Отклонено', phase: 4, tone: 'stop', open: false, hint: 'Отклонено с объяснением причин' },
  closed: { label: 'Закрыто', phase: 4, tone: 'idle', open: false, hint: 'Закрыто с объяснением (например, дубликат)' },
};

export const PHASES = ['Зарегистрировано', 'Рассмотрение', 'Решение', 'Реализация', 'Итог'] as const;

export const CHANNEL: Record<Channel, string> = {
  app: 'Приложение',
  meeting: 'Совещание',
  email: 'Почта',
  phone: 'Звонок',
  conversation: 'Устно',
  messenger: 'Мессенджер',
  other: 'Другое',
};

export const KIND = { idea: 'Предложение', problem: 'Проблема' } as const;
