import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { AppError } from '../domain/errors.ts';
import { withTx, type Database } from '../db/pool.ts';
import { getMe, resolveOrgActor } from '../modules/context.ts';
import { getIdea } from '../modules/ideas.ts';
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
import * as notificationsMod from '../modules/notifications.ts';
import * as wf from '../modules/workflow.ts';
import * as admin from '../modules/admin.ts';
import { analytics, AnalyticsQuery } from '../modules/analytics.ts';
import { kingdom } from '../modules/kingdom.ts';
import * as progress from '../modules/progress.ts';
import * as council from '../modules/council.ts';
import * as advisor from '../modules/advisor.ts';
import * as meetings from '../modules/meetings.ts';
import * as legacy from '../modules/legacy.ts';
import * as kprivacy from '../modules/knowledge-privacy.ts';
import * as district from '../modules/district.ts';
import * as titles from '../modules/titles.ts';
import * as retention from '../modules/retention.ts';
import type { TranscribeConfig } from '../modules/transcribe.ts';
import { engineReachable } from '../modules/transcribe.ts';
import type { ModelConfig } from '../modules/advisor-model.ts';
import { downloadAttachment, MAX_ATTACHMENT_BYTES, uploadAttachment } from '../modules/attachments.ts';
import { SubmitInput, submitItem } from '../modules/intake.ts';
import { SearchQuery, searchItems, SimilarQuery, similarItems } from '../modules/search.ts';
import type { IdempotentResult } from '../modules/idempotency.ts';
import { DevTokenAuthenticator, type Authenticator } from './authn.ts';
import { createStaticHandler } from './static.ts';

export interface AppConfig {
  db: Database;
  /** Preferred: an explicit authenticator (ADR-0009). */
  authenticator?: Authenticator;
  /** Shortcut for tests/local use: builds a DevTokenAuthenticator. */
  authSecret?: string;
  log?: (entry: Record<string, unknown>) => void;
  /** Serve the built web app from this directory for non-API paths. */
  staticDir?: string;
  /**
   * Demo login (development only, never in production): lists fictional
   * personas and issues a short-lived token for one of them. Clearly an
   * imitation of SSO for the hackathon demo (ADR-0009).
   */
  demo?: { personas: DemoPersonas; issue: (userId: string) => string };
  /** Optional local model for MODUS ADVISOR (ADR-0013). Null: rules only, labelled as such. */
  advisorModel?: ModelConfig | null;
  /** Test seam for the model provider. */
  advisorFetch?: typeof fetch;
  /** Optional local speech-to-text engine (ADR-0014). Null: no transcription, the UI offers typing it. */
  transcribeEngine?: TranscribeConfig | null;
}

export interface DemoPersonas {
  organization: string;
  organizationName: string;
  personas: { userId: string; name: string; title: string; department: string; hint: string }[];
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
  /** Binary payload (file download); sent as-is with `headers`. */
  raw?: Buffer;
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

/** Raw body for file uploads (attachments). */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => {
    req.resume();
    return new AppError('payload_too_large', 'Файл больше 5 МБ');
  };
  if (Number(req.headers['content-length'] ?? 0) > limit) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const queryObject = (q: URLSearchParams) => Object.fromEntries(q.entries());

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
  // List with filters and full-text search (Phase 2.5). `stage` keeps working as before.
  route('GET', `/api/v1/orgs/(?<org>${SLUG})/ideas`, async (ctx) => ({
    status: 200,
    body: await searchItems(db, await org(ctx), SearchQuery.parse(queryObject(ctx.query))),
  }));
  route('GET', `/api/v1/orgs/(?<org>${SLUG})/ideas/similar`, async (ctx) => ({
    status: 200,
    body: await similarItems(db, await org(ctx), SimilarQuery.parse(queryObject(ctx.query)).q),
  }));
  // Quick submission, or recording on a colleague's behalf (meeting / e-mail / call).
  route('POST', `/api/v1/orgs/(?<org>${SLUG})/ideas`, async (ctx) => {
    const r = await submitItem(db, await org(ctx), SubmitInput.parse(await ctx.body()), idemKey(ctx.req));
    const headers: Record<string, string> = r.replayed ? { 'Idempotent-Replayed': 'true' } : {};
    return { status: r.status, body: r.body, headers };
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

  // ---- Phase 2.5: implementation, attachments, directory, admin, analytics ---
  step('/implementer', wf.ImplementerInput, (a, n, i, _p, k) => wf.assignImplementer(db, a, n, i, k));
  step('/implementation', wf.CompleteImplementationInput, (a, n, i, _p, k) => wf.completeImplementation(db, a, n, i, k));
  step('/attribution/decline', z.object({}).strict(), (a, n, _i, _p, k) => wf.declineAttribution(db, a, n, k));

  route('POST', `${IDEA}/attachments`, async (ctx) => {
    const actor = await org(ctx);
    const contentType = (ctx.req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const rawName = ctx.req.headers['x-file-name'];
    let fileName = '';
    try {
      fileName = decodeURIComponent(Array.isArray(rawName) ? rawName[0]! : (rawName ?? ''));
    } catch {
      throw new AppError('validation_failed', 'Некорректное имя файла (X-File-Name, URL-encoded)');
    }
    const data = await readRaw(ctx.req, MAX_ATTACHMENT_BYTES);
    return { status: 201, body: await uploadAttachment(db, actor, NumberParam.parse(ctx.params.number), { fileName, contentType, data }) };
  });
  route('GET', `${IDEA}/attachments/(?<file>${UUID})`, async (ctx) => {
    const f = await downloadAttachment(db, await org(ctx), NumberParam.parse(ctx.params.number), ctx.params.file!);
    return {
      status: 200,
      raw: f.data,
      headers: {
        'Content-Type': f.contentType,
        'Content-Length': String(f.data.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ETag: `"${f.sha256}"`,
      },
    };
  });

  const ORG = `/api/v1/orgs/(?<org>${SLUG})`;
  const json = <S extends z.ZodType>(method: string, path: string, schema: S, run: (a: Awaited<ReturnType<typeof org>>, input: z.infer<S>, p: Record<string, string>) => Promise<unknown>, status = 200) =>
    route(method, `${ORG}${path}`, async (ctx) => ({ status, body: await run(await org(ctx), schema.parse(await ctx.body()), ctx.params) }));

  route('GET', `${ORG}/directory`, async (ctx) => ({ status: 200, body: await admin.getDirectory(db, await org(ctx)) }));
  route('GET', `${ORG}/routing-rules`, async (ctx) => ({ status: 200, body: await admin.listRules(db, await org(ctx)) }));
  json('POST', '/routing-rules', admin.RuleInput, (a, i) => admin.createRule(db, a, i), 201);
  json('POST', `/routing-rules/(?<id>${UUID})/active`, z.object({ active: z.boolean() }).strict(), (a, i, p) => admin.setRuleActive(db, a, p.id!, i.active));
  json('POST', '/departments', admin.DepartmentInput, (a, i) => admin.createDepartment(db, a, i), 201);
  json('PATCH', `/departments/(?<id>${UUID})`, admin.DepartmentInput.partial(), (a, i, p) => admin.updateDepartment(db, a, p.id!, i));
  json('POST', '/categories', admin.CategoryInput, (a, i) => admin.createCategory(db, a, i), 201);
  json('PATCH', `/categories/(?<id>${UUID})`, admin.CategoryInput.partial(), (a, i, p) => admin.updateCategory(db, a, p.id!, i));
  json('PATCH', '/settings', admin.SettingsInput, (a, i) => admin.updateSettings(db, a, i));
  route('GET', `${ORG}/kingdom`, async (ctx) => ({ status: 200, body: await kingdom(db, await org(ctx)) }));
  // ---- Kingdom progress and the council (0007, ADR-0012) -------------------
  route('GET', `${ORG}/rating`, async (ctx) => ({
    status: 200,
    body: await progress.rating(db, await org(ctx), progress.RatingQuery.parse(queryObject(ctx.query))),
  }));
  route('GET', `${ORG}/castles/(?<id>${UUID})`, async (ctx) => ({ status: 200, body: await progress.castle(db, await org(ctx), ctx.params.id!) }));
  // ---- «Живое Королевство» (0014, ADR-0019): district screen, civilization, person card ----
  route('GET', `${ORG}/castles/(?<id>${UUID})/district`, async (ctx) => ({ status: 200, body: await district.district(db, await org(ctx), ctx.params.id!) }));
  json('PUT', `/castles/(?<id>${UUID})/civilization`, district.CivilizationInput, (a, i, p) => district.setCivilization(db, a, p.id!, i.civilization));
  route('GET', `${ORG}/people/(?<id>${UUID})`, async (ctx) => ({ status: 200, body: await district.person(db, await org(ctx), ctx.params.id!) }));
  route('GET', `${ORG}/me/contribution`, async (ctx) => ({ status: 200, body: await progress.myContribution(db, await org(ctx)) }));
  json('PATCH', '/settings/progress', progress.ProgressSettingsInput, (a, i) => progress.updateProgressSettings(db, a, i));
  route('GET', `${ORG}/council`, async (ctx) => ({ status: 200, body: await council.listCouncil(db, await org(ctx)) }));
  route('GET', `${IDEA}/council`, async (ctx) => ({ status: 200, body: await council.getCouncil(db, await org(ctx), NumberParam.parse(ctx.params.number)) }));
  route('GET', `${IDEA}/progress`, async (ctx) => ({ status: 200, body: await progress.ideaProgress(db, await org(ctx), NumberParam.parse(ctx.params.number)) }));
  step('/council/entries', council.CouncilEntryInput, (a, n, i, _p, k) => council.addEntry(db, a, n, i, k));
  step('/council/handoff', council.HandoffInput, (a, n, i, _p, k) => council.handoff(db, a, n, i, k));
  // ---- MODUS ADVISOR (0008, ADR-0013): proposes, a person confirms ---------
  const model = config.advisorModel ?? null;
  route('GET', `${ORG}/advisor/status`, async (ctx) => {
    await org(ctx);
    return { status: 200, body: await advisor.advisorStatus(model, config.advisorFetch) };
  });
  route('GET', `${ORG}/me/profile`, async (ctx) => ({ status: 200, body: await advisor.getMyProfile(db, await org(ctx)) }));
  json('PUT', '/me/profile', advisor.ProfileInput, (a, i) => advisor.saveMyProfile(db, a, i));
  route('GET', `${ORG}/protocols`, async (ctx) => ({ status: 200, body: await advisor.listProtocols(db, await org(ctx)) }));
  route('POST', `${ORG}/protocols`, async (ctx) => {
    const actor = await org(ctx);
    const input = advisor.ProtocolInput.parse(await ctx.body());
    return replied(await advisor.createProtocol(db, actor, input, idemKey(ctx.req), model, config.advisorFetch));
  });
  route('GET', `${ORG}/protocols/(?<id>${UUID})`, async (ctx) => ({ status: 200, body: await advisor.getProtocol(db, await org(ctx), ctx.params.id!) }));
  route('POST', `${ORG}/protocols/(?<id>${UUID})/candidates/(?<c>${UUID})/accept`, async (ctx) => {
    const actor = await org(ctx);
    const input = advisor.AcceptCandidateInput.parse(await ctx.body());
    return replied(await advisor.acceptCandidate(db, actor, ctx.params.id!, ctx.params.c!, input, idemKey(ctx.req)));
  });
  route('POST', `${ORG}/protocols/(?<id>${UUID})/candidates/(?<c>${UUID})/dismiss`, async (ctx) => {
    const actor = await org(ctx);
    z.object({}).strict().parse(await ctx.body());
    return replied(await advisor.dismissCandidate(db, actor, ctx.params.id!, ctx.params.c!, idemKey(ctx.req)));
  });
  route('GET', `${IDEA}/executors`, async (ctx) => ({ status: 200, body: await advisor.suggestExecutors(db, await org(ctx), NumberParam.parse(ctx.params.number)) }));
  step('/executors', advisor.ConfirmExecutorInput, (a, n, i, _p, k) => advisor.confirmExecutor(db, a, n, i, k));

  // ---- Living kingdom (0009, ADR-0014): titles, meetings, recordings, findings ----
  const mdeps: meetings.MeetingDeps = { model, engine: config.transcribeEngine ?? null, fetchImpl: config.advisorFetch };
  route('GET', `${ORG}/titles`, async (ctx) => ({ status: 200, body: await titles.listTitles(db, await org(ctx)) }));
  json('PUT', `/titles/(?<m>${UUID})`, titles.AssignTitleInput, (a, i, p) => titles.assignTitle(db, a, p.m!, i));
  route('DELETE', `${ORG}/titles/(?<m>${UUID})`, async (ctx) => ({ status: 200, body: await titles.clearTitle(db, await org(ctx), ctx.params.m!) }));
  json('PUT', `/guild-titles/(?<d>${UUID})`, titles.GuildTitlesInput, (a, i, p) => titles.setGuildTitles(db, a, p.d!, i));

  route('GET', `${ORG}/engines`, async (ctx) => {
    await org(ctx);
    const engine = config.transcribeEngine ?? null;
    return {
      status: 200,
      body: {
        transcription: engine
          ? { configured: true, model: engine.model, reachable: await engineReachable(engine, config.advisorFetch) }
          : { configured: false, model: null, reachable: false },
        analysis: (await advisor.advisorStatus(model, config.advisorFetch)).model,
        note: engine ? 'Расшифровка — локальный движок на этом компьютере.' : 'Движок расшифровки не подключён: расшифровку вставляют вручную или используют подготовленную (помечается).',
      },
    };
  });
  route('GET', `${ORG}/meetings`, async (ctx) => ({ status: 200, body: await meetings.listMeetings(db, await org(ctx)) }));
  route('POST', `${ORG}/meetings`, async (ctx) => {
    const actor = await org(ctx);
    return replied(await meetings.createMeeting(db, actor, meetings.CreateMeetingInput.parse(await ctx.body()), idemKey(ctx.req)));
  });
  const MTG = `${ORG}/meetings/(?<id>${UUID})`;
  route('GET', MTG, async (ctx) => ({ status: 200, body: await meetings.getMeeting(db, await org(ctx), ctx.params.id!, mdeps) }));
  route('POST', `${MTG}/consent`, async (ctx) => {
    const actor = await org(ctx);
    const { consent } = z.object({ consent: z.enum(['given', 'declined']) }).strict().parse(await ctx.body());
    return { status: 200, body: await meetings.setConsent(db, actor, ctx.params.id!, consent) };
  });
  route('POST', `${MTG}/recording/start`, async (ctx) => {
    const actor = await org(ctx);
    z.object({}).strict().parse(await ctx.body());
    return { status: 200, body: await meetings.startRecording(db, actor, ctx.params.id!) };
  });
  route('POST', `${MTG}/recording`, async (ctx) => {
    const actor = await org(ctx);
    const contentType = String(ctx.req.headers['content-type'] ?? '');
    const source = ctx.req.headers['x-recording-source'] === 'microphone' ? 'microphone' : 'upload';
    const dur = Number(ctx.req.headers['x-duration-ms']);
    const data = await readRaw(ctx.req, meetings.MAX_RECORDING_BYTES);
    return {
      status: 201,
      body: await meetings.uploadRecording(db, actor, ctx.params.id!, { contentType, data, source, durationMs: Number.isInteger(dur) && dur >= 0 && dur <= 14400000 ? dur : null }),
    };
  });
  route('GET', `${MTG}/recording`, async (ctx) => {
    const f = await meetings.downloadRecording(db, await org(ctx), ctx.params.id!);
    return {
      status: 200,
      raw: f.data,
      headers: {
        'Content-Type': f.contentType,
        'Content-Length': String(f.data.length),
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        ETag: `"${f.sha256}"`,
      },
    };
  });
  route('POST', `${MTG}/transcripts`, async (ctx) => {
    const actor = await org(ctx);
    return { status: 201, body: await meetings.addTranscript(db, actor, ctx.params.id!, meetings.TranscriptInput.parse(await ctx.body())) };
  });
  route('POST', `${MTG}/transcribe`, async (ctx) => {
    const actor = await org(ctx);
    z.object({}).strict().parse(await ctx.body());
    return { status: 201, body: await meetings.transcribeRecording(db, actor, ctx.params.id!, mdeps) };
  });
  route('POST', `${MTG}/analyses`, async (ctx) => {
    const actor = await org(ctx);
    return { status: 201, body: await meetings.analyze(db, actor, ctx.params.id!, meetings.AnalyzeInput.parse(await ctx.body()), mdeps) };
  });
  route('POST', `${MTG}/findings/(?<f>${UUID})/accept`, async (ctx) => {
    const actor = await org(ctx);
    const input = meetings.AcceptFindingInput.parse(await ctx.body());
    return replied(await meetings.acceptFinding(db, actor, ctx.params.id!, ctx.params.f!, input, idemKey(ctx.req)));
  });
  route('POST', `${MTG}/findings/(?<f>${UUID})/(?<what>note|dismiss)`, async (ctx) => {
    const actor = await org(ctx);
    z.object({}).strict().parse(await ctx.body());
    return { status: 200, body: await meetings.decideFinding(db, actor, ctx.params.id!, ctx.params.f!, ctx.params.what === 'note' ? 'noted' : 'dismissed') };
  });
  route('GET', `${ORG}/retention`, async (ctx) => ({ status: 200, body: await retention.retentionOverview(db, await org(ctx)) }));
  json('PUT', '/retention', retention.RetentionInput, (a, i) => retention.setRetention(db, a, i));
  json('POST', `/meetings/(?<id>${UUID})/purge`, retention.PurgeInput, (a, i, p) => retention.purgeMedia(db, a, p.id!, i));
  json('POST', `/meetings/(?<id>${UUID})/legal-hold`, retention.HoldInput, (a, i, p) => retention.setLegalHold(db, a, p.id!, i));
  route('GET', `${ORG}/me/notification-preferences`, async (ctx) => ({ status: 200, body: await notificationsMod.getPreferences(db, await org(ctx)) }));
  json('PUT', '/me/notification-preferences', notificationsMod.PreferencesInput, (a, i) => notificationsMod.savePreferences(db, a, i));
  route('POST', `${MTG}/attendance`, async (ctx) => {
    const actor = await org(ctx);
    const { attendance } = z.object({ attendance: z.enum(['confirmed', 'declined']) }).strict().parse(await ctx.body());
    return { status: 200, body: await meetings.setAttendance(db, actor, ctx.params.id!, attendance) };
  });
  json('POST', `/meetings/(?<id>${UUID})/reschedule`, meetings.RescheduleInput, (a, i, p) => meetings.reschedule(db, a, p.id!, i));
  json('POST', `/meetings/(?<id>${UUID})/cancel`, meetings.CancelInput, (a, i, p) => meetings.cancel(db, a, p.id!, i));
  json('POST', `/meetings/(?<id>${UUID})/participants`, meetings.ParticipantInput, (a, i, p) => meetings.setParticipant(db, a, p.id!, i));
  route('GET', `${IDEA}/origin`, async (ctx) => ({ status: 200, body: await meetings.itemOrigin(db, await org(ctx), NumberParam.parse(ctx.params.number)) }));
  step('/effect', progress.EffectInput, (a, n, i, _p, k) => progress.approveEffect(db, a, n, i, k));

  // ---- «Наследие Королевства» (0012, ADR-0017): chronicle, library, higher archive ----
  route('GET', `${ORG}/knowledge`, async (ctx) => ({ status: 200, body: await legacy.list(db, await org(ctx), legacy.ListQuery.parse(queryObject(ctx.query))) }));
  json('POST', '/knowledge', legacy.RegisterInput, (a, i) => legacy.register(db, a, i), 201);
  const KN = `/knowledge/(?<id>${UUID})`;
  route('GET', `${ORG}${KN}`, async (ctx) => ({ status: 200, body: await legacy.get(db, await org(ctx), ctx.params.id!) }));
  route('GET', `${ORG}${KN}/helper`, async (ctx) => ({ status: 200, body: await legacy.helper(db, await org(ctx), ctx.params.id!) }));
  json('POST', `${KN}/versions`, legacy.ReviseInput, (a, i, p) => legacy.revise(db, a, p.id!, i), 201);
  json('POST', `${KN}/sources`, legacy.SourceInput, (a, i, p) => legacy.addSource(db, a, p.id!, i), 201);
  json('POST', `${KN}/applications`, legacy.ApplicationInput, (a, i, p) => legacy.addApplication(db, a, p.id!, i), 201);
  json('POST', `${KN}/actions`, legacy.ActInput, (a, i, p) => legacy.act(db, a, p.id!, i));
  route('GET', `${IDEA}/knowledge-draft`, async (ctx) => ({ status: 200, body: await legacy.draftFromItem(db, await org(ctx), NumberParam.parse(ctx.params.number)) }));
  json('POST', `/members/(?<id>${UUID})/archivist`, legacy.ArchivistInput, (a, i, p) => legacy.setArchivist(db, a, p.id!, i.grant));
  // Personal data in knowledge (0013, ADR-0018): admin-only scan, erasure, pseudonymization.
  route('GET', `${ORG}/privacy/knowledge`, async (ctx) => ({ status: 200, body: await kprivacy.scan(db, await org(ctx)) }));
  json('POST', `${KN}/erasure`, kprivacy.EraseInput, (a, i, p) => kprivacy.erase(db, a, p.id!, i));
  json('POST', `/members/(?<id>${UUID})/pseudonymize`, kprivacy.PseudonymizeInput, (a, i, p) => kprivacy.pseudonymize(db, a, p.id!, i));
  route('GET', `${ORG}/analytics`, async (ctx) => ({
    status: 200,
    body: await analytics(db, await org(ctx), AnalyticsQuery.parse(queryObject(ctx.query))),
  }));

  const serveStatic = config.staticDir ? createStaticHandler(config.staticDir) : null;
  const DemoLogin = z.object({ userId: z.uuid() }).strict();
  async function demoRoute(req: IncomingMessage, pathname: string): Promise<Reply> {
    const demo = config.demo;
    if (!demo) return { status: 404, body: { error: 'not_found', message: 'Демо-вход выключен' } };
    if (req.method === 'GET' && pathname === '/api/v1/demo/personas') return { status: 200, body: demo.personas };
    if (req.method === 'POST' && pathname === '/api/v1/demo/login') {
      const { userId } = DemoLogin.parse(await readJson(req));
      if (!demo.personas.personas.some((p) => p.userId === userId)) {
        return { status: 403, body: { error: 'forbidden', message: 'Это не демо-персона' } };
      }
      return { status: 200, body: { token: demo.issue(userId), organization: demo.personas.organization } };
    }
    return { status: 404, body: { error: 'not_found', message: 'Не найдено' } };
  }

  function send(res: ServerResponse, reply: Reply, requestId: string) {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, 'X-Request-Id': requestId, ...reply.headers };
    if (reply.status === 413) headers.Connection = 'close';
    if (reply.raw) {
      res.writeHead(reply.status, headers).end(reply.raw);
      return;
    }
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
      } else if (url.pathname.startsWith('/api/v1/demo/')) {
        reply = await demoRoute(req, url.pathname);
      } else if (serveStatic && !url.pathname.startsWith('/api/') && (req.method === 'GET' || req.method === 'HEAD')) {
        await serveStatic(req, res, url.pathname);
        return;
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
