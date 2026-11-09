import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AppError } from '../domain/errors.ts';
import { IDEA_STAGES } from '../domain/model.ts';
import { withTx, type Database } from '../db/pool.ts';
import { getMe, resolveOrgActor } from '../modules/context.ts';
import { getIdea, listIdeas } from '../modules/ideas.ts';
import {
  CreateDraftInput,
  PublishInput,
  SaveVersionInput,
  createDraft,
  deleteDraft,
  getDraft,
  listDrafts,
  publishDraft,
  saveVersion,
} from '../modules/lab.ts';
import { listInbox, markRead } from '../modules/notifications.ts';
import * as wf from '../modules/workflow.ts';
import type { IdempotentResult } from '../modules/idempotency.ts';
import { DevTokenAuthenticator, type Authenticator } from './authn.ts';

export interface AppConfig {
  db: Database;
  /** Preferred: an explicit authenticator (ADR-0009). */
  authenticator?: Authenticator;
  /** Shortcut for tests/local use: builds a DevTokenAuthenticator. */
  authSecret?: string;
  log?: (entry: Record<string, unknown>) => void;
}

interface Ctx {
  req: IncomingMessage;
  params: Record<string, string>;
  query: URLSearchParams;
  userId: string;
  body: () => Promise<unknown>;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Handler = (ctx: Ctx) => Promise<Reply>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const MAX_BODY = 256 * 1024;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SLUG = '[a-z0-9][a-z0-9-]{1,62}';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json(\s*;|$)/i.test(type)) {
    throw new AppError('unsupported_media_type', 'Ожидается Content-Type: application/json');
  }
  const tooLarge = () => {
    req.resume(); // discard the rest so the client receives the 413 instead of a reset
    return new AppError('payload_too_large', 'Слишком большой запрос');
  };
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw tooLarge();
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8'); // decode once: multi-byte safe
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AppError('validation_failed', 'Некорректный JSON');
  }
}

const idemKey = (req: IncomingMessage) => {
  const v = req.headers['idempotency-key'];
  return Array.isArray(v) ? v[0] : v;
};

const NumberParam = z.coerce.number().int().positive().max(2_147_483_647);
const MarkReadInput = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();

export function createApp(config: AppConfig) {
  const { db } = config;
  const authenticator = config.authenticator ?? new DevTokenAuthenticator(config.authSecret);
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, pattern: new RegExp(`^${path}$`), handler });
  const org = (ctx: Ctx) => resolveOrgActor(db, ctx.userId, ctx.params.org!);

  // ---- identity -----------------------------------------------------------
  route('GET', '/api/v1/me', async (ctx) => ({ status: 200, body: await getMe(db, ctx.userId) }));

  // ---- personal lab (private) ---------------------------------------------
  route('GET', '/api/v1/lab/drafts', async (ctx) => ({ status: 200, body: await listDrafts(db, ctx.userId) }));
  route('POST', '/api/v1/lab/drafts', async (ctx) => ({
    status: 201,
    body: await createDraft(db, ctx.userId, CreateDraftInput.parse(await ctx.body())),
  }));
  route('GET', `/api/v1/lab/drafts/(?<id>${UUID})`, async (ctx) => ({
    status: 200,
    body: await getDraft(db, ctx.userId, ctx.params.id!),
  }));
  route('DELETE', `/api/v1/lab/drafts/(?<id>${UUID})`, async (ctx) => {
    await deleteDraft(db, ctx.userId, ctx.params.id!);
    return { status: 204 };
  });
  route('POST', `/api/v1/lab/drafts/(?<id>${UUID})/versions`, async (ctx) => ({
    status: 201,
    body: await saveVersion(db, ctx.userId, ctx.params.id!, SaveVersionInput.parse(await ctx.body())),
  }));
  route('POST', `/api/v1/lab/drafts/(?<id>${UUID})/publish`, async (ctx) => {
    const r = await publishDraft(db, ctx.userId, ctx.params.id!, PublishInput.parse(await ctx.body()), idemKey(ctx.req));
    const headers: Record<string, string> = r.replayed ? { 'Idempotent-Replayed': 'true' } : {};
    return { status: r.status, body: r.body, headers };
  });

  // ---- organization workspace ---------------------------------------------
  route('GET', `/api/v1/orgs/(?<org>${SLUG})/ideas`, async (ctx) => {
    const stage = ctx.query.get('stage');
    const parsed = stage === null ? undefined : z.enum(IDEA_STAGES).parse(stage);
    return { status: 200, body: await listIdeas(db, await org(ctx), parsed) };
  });
  route('GET', `/api/v1/orgs/(?<org>${SLUG})/ideas/(?<number>\\d{1,10})`, async (ctx) => ({
    status: 200,
    body: await getIdea(db, await org(ctx), NumberParam.parse(ctx.params.number)),
  }));
  route('GET', `/api/v1/orgs/(?<org>${SLUG})/notifications`, async (ctx) => ({
    status: 200,
    body: await listInbox(db, await org(ctx)),
  }));
  route('POST', `/api/v1/orgs/(?<org>${SLUG})/notifications/read`, async (ctx) => ({
    status: 200,
    body: { updated: await markRead(db, await org(ctx), MarkReadInput.parse(await ctx.body()).ids) },
  }));

  /** A valid signature is not enough: the user must still exist (deleted users lose access at once). */
  const userExists = (userId: string) =>
    withTx(db, { userId }, async (c) => (await c.query('SELECT 1 FROM users WHERE id = app_user_id()')).rowCount === 1);

  // ---- workflow (Phase 2) ---------------------------------------------------
  // Every mutation accepts an Idempotency-Key header and returns 201 with the
  // resulting state; a replay returns the stored response with Idempotent-Replayed.
  const IDEA = `/api/v1/orgs/(?<org>${SLUG})/ideas/(?<number>\\d{1,10})`;
  const replied = <T>(r: IdempotentResult<T>): Reply => ({
    status: r.status,
    body: r.body,
    headers: r.replayed ? { 'Idempotent-Replayed': 'true' } : {},
  });
  const step = <S extends z.ZodType>(
    path: string,
    schema: S,
    run: (actor: Awaited<ReturnType<typeof org>>, n: number, input: z.infer<S>, params: Record<string, string>, key?: string) => Promise<IdempotentResult<unknown>>,
  ) =>
    route('POST', `${IDEA}${path}`, async (ctx) => {
      const actor = await org(ctx);
      const input = schema.parse(await ctx.body());
      return replied(await run(actor, NumberParam.parse(ctx.params.number), input, ctx.params, idemKey(ctx.req)));
    });

  step('/assignments', wf.AssignInput, (a, n, i, _p, k) => wf.assign(db, a, n, i, k));
  step('/reviews', wf.ReviewInput, (a, n, i, _p, k) => wf.addReview(db, a, n, i, k));
  step(`/reviews/(?<review>${UUID})/resolve`, wf.ResolveInput, (a, n, i, p, k) => wf.resolveReview(db, a, n, p.review!, i, k));
  step('/revisions', wf.ReviseInput, (a, n, i, _p, k) => wf.revise(db, a, n, i, k));
  step('/suggestions', wf.SuggestInput, (a, n, i, _p, k) => wf.suggest(db, a, n, i, k));
  step('/suggestions/(?<rev>\\d{1,6})/decision', wf.SuggestionDecisionInput, (a, n, i, p, k) =>
    wf.decideSuggestion(db, a, n, NumberParam.parse(p.rev), i, k),
  );
  step('/verifications', wf.StartVerificationInput, (a, n, i, _p, k) => wf.startVerification(db, a, n, i, k));
  step(`/verifications/(?<v>${UUID})/evidence`, wf.EvidenceInput, (a, n, i, p, k) => wf.recordEvidence(db, a, n, p.v!, i, k));
  step(`/verifications/(?<v>${UUID})/conclusion`, wf.ConcludeInput, (a, n, i, p, k) => wf.concludeVerification(db, a, n, p.v!, i, k));
  step('/decision', wf.DecideInput, (a, n, i, _p, k) => wf.decide(db, a, n, i, k));

  function send(res: ServerResponse, reply: Reply, requestId: string) {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, 'X-Request-Id': requestId, ...reply.headers };
    if (reply.status === 413) headers.Connection = 'close';
    if (reply.body === undefined) {
      res.writeHead(reply.status, headers).end();
      return;
    }
    headers['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(reply.status, headers).end(JSON.stringify(reply.body));
  }

  function errorReply(error: unknown): Reply {
    if (error instanceof ZodError) {
      return {
        status: 422,
        body: { error: 'validation_failed', message: 'Некорректные данные', issues: error.issues.map((i) => ({ path: i.path, message: i.message })) },
      };
    }
    if (error instanceof AppError) {
      return { status: error.status, body: { error: error.code, message: error.message, details: error.details } };
    }
    return { status: 500, body: { error: 'internal', message: 'Внутренняя ошибка' } };
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    let reply: Reply;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/v1/health') {
        reply = { status: 200, body: { ok: true } };
      } else {
        const candidates = routes.filter((r) => r.pattern.test(url.pathname));
        const match = candidates.find((r) => r.method === req.method);
        if (!match) {
          reply = candidates.length
            ? { status: 405, body: { error: 'method_not_allowed' } }
            : { status: 404, body: { error: 'not_found', message: 'Не найдено' } };
        } else {
          const auth = req.headers.authorization ?? '';
          const claims = auth.startsWith('Bearer ') ? await authenticator.authenticate(auth.slice(7)) : null;
          if (!claims || !(await userExists(claims.userId))) {
            reply = { status: 401, body: { error: 'unauthenticated', message: 'Требуется вход' } };
          } else {
            reply = await match.handler({
              req,
              params: { ...match.pattern.exec(url.pathname)!.groups },
              query: url.searchParams,
              userId: claims.userId,
              body: () => readJson(req),
            });
          }
        }
      }
    } catch (error) {
      reply = errorReply(error);
      if (reply.status >= 500) config.log?.({ level: 'error', requestId, error: String((error as Error)?.stack ?? error) });
    }
    send(res, reply, requestId);
    config.log?.({ level: 'info', requestId, method: req.method, path: req.url?.split('?')[0], status: reply.status, ms: Date.now() - started });
  };
}
