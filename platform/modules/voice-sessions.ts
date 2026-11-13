import { randomUUID } from 'node:crypto';
import { AppError, notFound } from '../domain/errors.ts';
import type { VoiceLimits } from './voice-realtime.ts';

/**
 * Live voice sessions held by the server (ADR-0043). In memory on purpose: a conversation is not a
 * record. Nothing said is stored here — only who may use the session, until when, and counters.
 *
 * Every session belongs to one user in one organization. Any request about a session made by
 * someone else, from another organization, after the end or after the time limit gets the same 404
 * as an unknown id, so session ids cannot be probed.
 */
export interface VoiceSession {
  id: string;
  userId: string;
  orgId: string;
  membershipId: string;
  language: 'ru' | 'kk';
  /** What the employee opened the advisor from (a council item); null for the general advisor. */
  context: { kind: 'council'; number: number } | null;
  createdAt: number;
  deadline: number;
  /** Server-only: the short-lived provider secret, dropped after the one SDP relay. */
  secret: string | null;
  callId: string | null;
  toolCalls: number;
  endedAt: number | null;
  endReason: string | null;
}

export class VoiceSessionRegistry {
  readonly #sessions = new Map<string, VoiceSession>();
  /** Session start times per user, for the hourly limit (kept after a session ends). */
  readonly #starts = new Map<string, number[]>();
  readonly #limits: VoiceLimits;
  readonly #now: () => number;

  constructor(limits: VoiceLimits, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  get limits(): VoiceLimits {
    return this.#limits;
  }

  #live(s: VoiceSession): boolean {
    return s.endedAt === null && this.#now() < s.deadline;
  }

  /** Ends sessions past their deadline and forgets ended ones after a while. */
  sweep(): VoiceSession[] {
    const now = this.#now();
    const expired: VoiceSession[] = [];
    for (const s of this.#sessions.values()) {
      if (s.endedAt === null && now >= s.deadline) {
        s.endedAt = now;
        s.endReason = 'time_limit';
        s.secret = null;
        expired.push(s);
      }
      if (s.endedAt !== null && now - s.endedAt > 10 * 60_000) this.#sessions.delete(s.id);
    }
    for (const [user, list] of this.#starts) {
      const recent = list.filter((t) => now - t < 3600_000);
      if (recent.length) this.#starts.set(user, recent);
      else this.#starts.delete(user);
    }
    return expired;
  }

  /** Checks every limit before any paid call is made; throws a 429 that says which one. */
  reserve(input: { userId: string; orgId: string; membershipId: string; language: 'ru' | 'kk'; context: VoiceSession['context'] }): VoiceSession {
    this.sweep();
    const now = this.#now();
    const live = [...this.#sessions.values()].filter((s) => this.#live(s));
    if (live.filter((s) => s.userId === input.userId).length >= this.#limits.maxPerUser) {
      throw new AppError('rate_limited', 'У вас уже идёт разговор с советником. Завершите его, чтобы начать новый');
    }
    if (live.filter((s) => s.orgId === input.orgId).length >= this.#limits.maxPerOrg) {
      throw new AppError('rate_limited', 'Сейчас с советником говорит слишком много сотрудников. Попробуйте через несколько минут или спросите текстом');
    }
    const starts = (this.#starts.get(input.userId) ?? []).filter((t) => now - t < 3600_000);
    if (starts.length >= this.#limits.sessionsPerHour) {
      throw new AppError('rate_limited', `Не больше ${this.#limits.sessionsPerHour} разговоров в час. Попробуйте позже или спросите текстом`);
    }
    starts.push(now);
    this.#starts.set(input.userId, starts);
    const s: VoiceSession = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      deadline: now + this.#limits.maxSeconds * 1000,
      secret: null,
      callId: null,
      toolCalls: 0,
      endedAt: null,
      endReason: null,
    };
    this.#sessions.set(s.id, s);
    return s;
  }

  /** The live session of exactly this user in exactly this organization. */
  get(id: string, userId: string, orgId: string): VoiceSession {
    this.sweep();
    const s = this.#sessions.get(id);
    if (!s || s.userId !== userId || s.orgId !== orgId || !this.#live(s)) throw notFound('Голосовая сессия не найдена или завершена');
    return s;
  }

  /** Counts a tool call; a conversation that keeps asking is stopped with an error the model hears. */
  countTool(s: VoiceSession): void {
    if (s.toolCalls >= this.#limits.toolCallsPerSession) {
      throw new AppError('rate_limited', 'Достигнут предел запросов к данным в одном разговоре. Начните новый разговор');
    }
    s.toolCalls++;
  }

  end(s: VoiceSession, reason: string): void {
    if (s.endedAt !== null) return;
    s.endedAt = this.#now();
    s.endReason = reason;
    s.secret = null;
  }

  /** A failed start must not hold the user's single slot (the hourly count stays: the attempt was made). */
  discard(s: VoiceSession): void {
    this.#sessions.delete(s.id);
  }

  activeCount(): number {
    return [...this.#sessions.values()].filter((s) => this.#live(s)).length;
  }
}
