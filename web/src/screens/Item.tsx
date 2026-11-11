import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ItemKingdom } from '../components/ItemKingdom';
import { EnvoyShortcut } from '../components/Audience';
import { ItemOrigin } from '../components/ItemOrigin';
import { api, errorText } from '../lib/api';
import { facts, type Facts } from '../lib/can';
import { ago, bytes, dateTime, due } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import { CHANNEL, KIND } from '../lib/status';
import type { IdeaDetail, Review, Verification } from '../lib/types';
import { ErrorBox, Flags, Loading, Signal, StatusChip } from '../components/ui';
import { buildTimeline, EVIDENCE_LABEL } from './timeline';
import { ACCEPT, downloadFile, uploadFile } from './files';

type Mode =
  | null
  | 'comment'
  | 'ask'
  | 'progress'
  | 'revise'
  | 'assign'
  | 'check'
  | 'decide'
  | 'implementer'
  | 'complete'
  | `object:${string}`
  | `resolve:${string}`
  | `evidence:${string}`
  | `conclude:${string}`;

export function ItemPage({ number }: { number: number }) {
  const s = useSession();
  const { data: item, error, loading, reload } = useLoad(() => api<IdeaDetail>(`/orgs/${s.org}/ideas/${number}`), [s.org, number]);
  const [mode, setMode] = useState<Mode>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('audience') === 'decide' ? 'decide' : null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (loading && !item) return <Loading />;
  if (error && !item) return <ErrorBox error={error} retry={() => void reload()} />;
  if (!item) return null;

  const f = facts({ membershipId: s.membershipId, roles: s.roles }, item);
  const current = item.revisions.find((r) => r.number === item.currentRevision) ?? item.revisions[item.revisions.length - 1]!;
  const openQuestions = item.reviews.filter((r) => r.kind === 'request_changes' && r.state === 'open');

  /** Sends one workflow step, then reloads the item. */
  async function run(path: string, json: unknown, done: string) {
    setBusy(true);
    setFormError(null);
    try {
      await api(`/orgs/${s.org}/ideas/${number}${path}`, { json });
      await reload();
      setMode(null);
      s.toast(done);
      void s.refreshInbox();
    } catch (e) {
      setFormError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const open = (m: Mode) => {
    setFormError(null);
    setMode(m);
  };

  const ctx: ComposerCtx = { item, f, busy, error: formError, run, close: () => setMode(null), s };

  return (
    <article className="stack-lg">
      <a className="back" href={s.isLead ? '#/work' : '#/'}>
        {s.isLead ? 'Рабочее место' : 'Мои обращения'}
      </a>

      <header className="item-head stack">
        <div className="row small muted">
          <span className="number">№{item.number}</span>
          <span>{KIND[item.kind]}</span>
          {item.category && <span>{item.category}</span>}
        </div>
        <h1>{current.title}</h1>
        <div className="row">
          <StatusChip status={item.status} />
          <Flags item={item} />
        </div>
        <Signal status={item.status} />
        <p className="now">{nowLine(item)}</p>
        <ItemKingdom item={item} />
        <ItemOrigin number={item.number} />
        <EnvoyShortcut item={item} />
        {s.isLead || s.isAdmin || s.isArchivist ? (
          <div className="row">
            <a className="btn small" href={`#/library/new?idea=${item.number}`}>
              Внести в Летопись
            </a>
            <span className="xs faint">Черновик карточки из этого обращения — проверите перед записью</span>
          </div>
        ) : null}
      </header>

      {openQuestions.length > 0 && f.author && (
        <div className="notice warn" role="status">
          <b>Ответственный ждёт вашего ответа.</b> Уточните текст новой версией или возразите, если с вопросом не согласны — ваш ответ сохранится в истории.
        </div>
      )}

      <div className="item-grid">
        <div className="stack-lg">
          <section className="essence panel" aria-label="Суть обращения">
            <h3>{item.kind === 'problem' ? 'Что происходит' : 'Проблема'}</h3>
            <p className="prose">{current.problem}</p>
            {current.proposal && (
              <>
                <h3>Предложение</h3>
                <p className="prose">{current.proposal}</p>
              </>
            )}
            {current.success_criteria && (
              <>
                <h3>Как поймём, что решено</h3>
                <p className="prose">{current.success_criteria}</p>
              </>
            )}
            {item.revisions.length > 1 && (
              <p className="xs faint" style={{ marginTop: 14 }}>
                Версия {current.number} из {item.revisions.length}. Прежние версии сохранены в истории.
              </p>
            )}
          </section>

          <section aria-label="Действия" className="stack">
            <Actions f={f} item={item} mode={mode} open={open} reload={reload} busy={busy} />
            {mode === 'decide' && !f.decide ? <p className="small muted">Внедрение оформляет назначенный ответственный за решение, не игровой титул.</p> : mode && <Composer mode={mode} ctx={ctx} />}
          </section>

          <section aria-label="История" className="stack">
            <h2 className="section-title">История</h2>
            <Timeline item={item} f={f} open={open} org={s.org} />
          </section>
        </div>

        <Passport item={item} reload={reload} />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
function nowLine(i: IdeaDetail): string {
  const m = i.maintainer?.name;
  switch (i.status) {
    case 'unrouted':
      return 'Ответственный ещё не назначен. Обращение видят все руководители и контактное лицо по эскалациям.';
    case 'in_review': {
      if (!i.firstResponseAt && i.firstResponseDueAt) return `Ведёт ${m}. Первый ответ ${due(i.firstResponseDueAt)?.text}.`;
      return i.resolutionDueAt ? `Ведёт ${m}. Срок решения ${due(i.resolutionDueAt)?.text}.` : `Ведёт ${m}.`;
    }
    case 'needs_info':
      return `${m ?? 'Ответственный'} задал вопрос и ждёт уточнения от автора.`;
    case 'in_verification': {
      const v = i.verifications.find((x) => x.status === 'running');
      return `Идёт проверка на практике${v ? `, проводит ${v.owner}` : ''}. Результаты, включая неудачные, сохраняются.`;
    }
    case 'decision':
      return `Решение принимает ${i.decisionOwner?.name ?? 'ответственный за решение'}.`;
    case 'in_progress':
      return `Решение принято. Внедряет ${i.implementer ?? m}.`;
    case 'implemented':
      return 'Изменение внедрено. Отчёт исполнителя — в истории.';
    case 'rejected':
      return 'Отклонено. Причина записана в решении — оно в истории.';
    case 'closed':
      return 'Закрыто. Причина записана в решении — оно в истории.';
  }
}

function Actions({ f, item, mode, open, reload, busy }: { f: Facts; item: IdeaDetail; mode: Mode; open: (m: Mode) => void; reload: () => Promise<void>; busy: boolean }) {
  const s = useSession();
  const b = (m: Exclude<Mode, null>, label: string, primary = false) => (
    <button key={m} className={`btn${primary ? ' primary' : ''}`} aria-expanded={mode === m} disabled={busy} onClick={() => open(mode === m ? null : m)}>
      {label}
    </button>
  );
  const takeOver = async () => {
    try {
      const both = s.roles.includes('decision_owner');
      await api(`/orgs/${s.org}/ideas/${item.number}/assignments`, {
        json: { maintainer: s.membershipId, ...(both ? { decisionOwner: s.membershipId } : {}) },
      });
      s.toast('Вы ведёте это обращение. Автор получил уведомление.');
      await reload();
    } catch (e) {
      s.toast(errorText(e));
    }
  };
  const decline = async () => {
    if (!window.confirm('Убрать вас из «поднял вопрос»? Запись об этом останется в истории.')) return;
    try {
      await api(`/orgs/${s.org}/ideas/${item.number}/attribution/decline`, { json: {} });
      s.toast('Вы больше не указаны автором вопроса');
      await reload();
    } catch (e) {
      s.toast(errorText(e));
    }
  };

  const buttons: ReactNode[] = [];
  if (f.takeOver)
    buttons.push(
      <button key="take" className="btn primary" onClick={() => void takeOver()}>
        Взять в работу
      </button>,
    );
  if (f.decide) buttons.push(b('decide', 'Принять решение', true));
  if (f.complete) buttons.push(b('complete', 'Отметить как реализовано', true));
  if (f.askAuthor) buttons.push(b('ask', 'Задать вопрос автору'));
  if (f.startCheck) buttons.push(b('check', 'Проверить на практике'));
  if (f.revise) buttons.push(b('revise', 'Уточнить текст', item.status === 'needs_info'));
  if (f.progress) buttons.push(b('progress', 'Сообщить о ходе работ'));
  if (f.setImplementer && !item.implementerMembershipId) buttons.push(b('implementer', 'Назначить исполнителя'));
  if (f.assign && item.maintainer) buttons.push(b('assign', 'Передать другому'));
  if (f.comment) buttons.push(b('comment', 'Комментировать'));
  if (f.declineCredit)
    buttons.push(
      <button key="decline" className="btn quiet" onClick={() => void decline()}>
        Это не мой вопрос
      </button>,
    );
  if (!buttons.length) return <p className="small muted">Обращение завершено. История остаётся доступной.</p>;
  return <div className="actions">{buttons}</div>;
}

// ---------------------------------------------------------------------------
interface ComposerCtx {
  item: IdeaDetail;
  f: Facts;
  busy: boolean;
  error: string | null;
  run: (path: string, json: unknown, done: string) => Promise<void>;
  close: () => void;
  s: ReturnType<typeof useSession>;
}

function Composer({ mode, ctx }: { mode: Exclude<Mode, null>; ctx: ComposerCtx }) {
  const [kind, id] = mode.split(':') as [string, string | undefined];
  switch (kind) {
    case 'comment':
      return <TextForm ctx={ctx} label="Комментарий" submit="Отправить" onSubmit={(t) => ctx.run('/reviews', { kind: 'comment', body: t }, 'Комментарий добавлен')} min={1} />;
    case 'ask':
      return (
        <TextForm
          ctx={ctx}
          label="Вопрос автору"
          hint="Автор получит уведомление. Пока вопрос открыт, обращение в статусе «Нужны уточнения»."
          submit="Задать вопрос"
          onSubmit={(t) => ctx.run('/reviews', { kind: 'request_changes', body: t }, 'Вопрос отправлен автору')}
          min={5}
        />
      );
    case 'progress':
      return (
        <TextForm
          ctx={ctx}
          label="Что сделано и что дальше"
          hint="Отчёт увидят автор и участники. Он не меняет статус."
          submit="Отправить отчёт"
          onSubmit={(t) => ctx.run('/reviews', { kind: 'progress', body: t }, 'Отчёт отправлен')}
          min={5}
        />
      );
    case 'object':
      return (
        <TextForm
          ctx={ctx}
          label="Ваше возражение"
          hint="Объясните, почему вопрос или замечание неверны. Возражение останется в истории рядом с вопросом."
          submit="Возразить"
          onSubmit={(t) => ctx.run('/reviews', { kind: 'objection', body: t, parentReviewId: id }, 'Возражение записано')}
          min={5}
        />
      );
    case 'resolve':
      return (
        <TextForm
          ctx={ctx}
          label="Чем закрыт вопрос"
          submit="Закрыть вопрос"
          onSubmit={(t) => ctx.run(`/reviews/${id}/resolve`, { outcome: 'resolved', note: t }, 'Вопрос закрыт')}
          min={5}
        />
      );
    case 'complete':
      return (
        <TextForm
          ctx={ctx}
          label="Что внедрено"
          hint="Отчёт увидят автор и руководство. Статус станет «Реализовано»."
          submit="Отметить как реализовано"
          onSubmit={(t) => ctx.run('/implementation', { report: t }, 'Обращение отмечено как реализованное')}
          min={10}
        />
      );
    case 'revise':
      return <ReviseForm ctx={ctx} />;
    case 'decide':
      return <DecideForm ctx={ctx} />;
    case 'implementer':
      return <ImplementerForm ctx={ctx} />;
    case 'assign':
      return <AssignForm ctx={ctx} />;
    case 'check':
      return <CheckForm ctx={ctx} />;
    case 'evidence':
      return <EvidenceForm ctx={ctx} verificationId={id!} />;
    case 'conclude':
      return <ConcludeForm ctx={ctx} verificationId={id!} />;
    default:
      return null;
  }
}

function FormShell({ ctx, children, submit, disabled, onSubmit }: { ctx: ComposerCtx; children: ReactNode; submit: string; disabled?: boolean; onSubmit: () => void }) {
  return (
    <form
      className="composer panel stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !ctx.busy) onSubmit();
      }}
    >
      {children}
      {ctx.error && (
        <div className="notice error" role="alert">
          {ctx.error}
        </div>
      )}
      <div className="row">
        <button className="btn primary" type="submit" disabled={disabled || ctx.busy}>
          {ctx.busy ? 'Сохраняем…' : submit}
        </button>
        <button className="btn quiet" type="button" onClick={ctx.close}>
          Отмена
        </button>
      </div>
    </form>
  );
}

function TextForm({ ctx, label, hint, submit, onSubmit, min }: { ctx: ComposerCtx; label: string; hint?: string; submit: string; onSubmit: (t: string) => void; min: number }) {
  const [t, setT] = useState('');
  const ok = t.trim().length >= min;
  return (
    <FormShell ctx={ctx} submit={submit} disabled={!ok} onSubmit={() => onSubmit(t.trim())}>
      <div className="field">
        <label htmlFor="composer-text">{label}</label>
        <textarea id="composer-text" className="textarea" autoFocus value={t} onChange={(e) => setT(e.target.value)} maxLength={5000} />
        {hint && <span className="hint">{hint}</span>}
      </div>
    </FormShell>
  );
}

function ReviseForm({ ctx }: { ctx: ComposerCtx }) {
  const cur = ctx.item.revisions.find((r) => r.number === ctx.item.currentRevision)!;
  const [title, setTitle] = useState(cur.title);
  const [problem, setProblem] = useState(cur.problem);
  const [proposal, setProposal] = useState(cur.proposal ?? '');
  const [criteria, setCriteria] = useState(cur.success_criteria ?? '');
  const [why, setWhy] = useState('');
  const isIdea = ctx.item.kind === 'idea';
  const ok = title.trim().length >= 3 && problem.trim().length >= 20 && (!isIdea || proposal.trim().length >= 20);
  return (
    <FormShell
      ctx={ctx}
      submit="Сохранить новую версию"
      disabled={!ok}
      onSubmit={() =>
        void ctx.run(
          '/revisions',
          {
            baseRevision: cur.number,
            title: title.trim(),
            problem: problem.trim(),
            ...(proposal.trim() ? { proposal: proposal.trim() } : {}),
            ...(criteria.trim().length >= 10 ? { successCriteria: criteria.trim() } : {}),
            ...(why.trim().length >= 5 ? { rationale: why.trim() } : {}),
          },
          'Новая версия сохранена, ответственный получил уведомление',
        )
      }
    >
      <p className="small muted">Прежняя версия не стирается — в истории видно, что изменилось.</p>
      <div className="field">
        <label htmlFor="rv-title">Коротко</label>
        <input id="rv-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
      </div>
      <div className="field">
        <label htmlFor="rv-problem">{isIdea ? 'Проблема' : 'Что происходит'}</label>
        <textarea id="rv-problem" className="textarea" value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={5000} />
      </div>
      <div className="field">
        <label htmlFor="rv-proposal">{isIdea ? 'Предложение' : 'Как можно решить (необязательно)'}</label>
        <textarea id="rv-proposal" className="textarea" value={proposal} onChange={(e) => setProposal(e.target.value)} maxLength={5000} />
      </div>
      <div className="field">
        <label htmlFor="rv-criteria">Как поймём, что решено</label>
        <input id="rv-criteria" className="input" value={criteria} onChange={(e) => setCriteria(e.target.value)} maxLength={3000} />
      </div>
      <div className="field">
        <label htmlFor="rv-why">Что уточнили</label>
        <input id="rv-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={3000} placeholder="Например: указала смену и номер ворот" />
      </div>
    </FormShell>
  );
}

function MemberSelect({ id, value, onChange, exclude = [], filter, empty = 'Выберите сотрудника' }: { id: string; value: string; onChange: (v: string) => void; exclude?: (string | null | undefined)[]; filter?: (roles: string[]) => boolean; empty?: string }) {
  const s = useSession();
  const members = (s.directory?.members ?? []).filter((m) => !exclude.includes(m.membershipId) && (!filter || filter(m.roles)));
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {members.map((m) => (
        <option key={m.membershipId} value={m.membershipId}>
          {m.name}
          {m.jobTitle ? `, ${m.jobTitle}` : m.department ? `, ${m.department}` : ''}
        </option>
      ))}
    </select>
  );
}

function DecideForm({ ctx }: { ctx: ComposerCtx }) {
  const [outcome, setOutcome] = useState<'merge' | 'reject' | 'close'>('merge');
  const [why, setWhy] = useState('');
  const [implementer, setImplementer] = useState('');
  const failed = ctx.item.verifications.filter((v) => v.outcome === 'negative').length;
  const ok = why.trim().length >= 10;
  return (
    <FormShell
      ctx={ctx}
      submit={outcome === 'merge' ? 'Внедрить' : outcome === 'reject' ? 'Отклонить' : 'Закрыть'}
      disabled={!ok}
      onSubmit={() =>
        void ctx.run(
          '/decision',
          { outcome, rationale: why.trim(), ...(outcome === 'merge' && implementer ? { implementer } : {}) },
          outcome === 'merge' ? 'Решение принято: внедрить' : 'Решение записано, автор получил объяснение',
        )
      }
    >
      <div className="segmented" role="group" aria-label="Решение">
        <button type="button" aria-pressed={outcome === 'merge'} onClick={() => setOutcome('merge')}>
          Внедрить
        </button>
        <button type="button" aria-pressed={outcome === 'reject'} onClick={() => setOutcome('reject')}>
          Отклонить
        </button>
        <button type="button" aria-pressed={outcome === 'close'} onClick={() => setOutcome('close')}>
          Закрыть
        </button>
      </div>
      {failed > 0 && <div className="notice warn">В проверках есть отрицательный результат ({failed}). Решение будет показано рядом с ним.</div>}
      <div className="field">
        <label htmlFor="dc-why">{outcome === 'merge' ? 'Почему внедряем' : outcome === 'reject' ? 'Почему отклоняем — автор увидит это объяснение' : 'Почему закрываем (например, дубликат №…)'}</label>
        <textarea id="dc-why" className="textarea" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={5000} />
      </div>
      {outcome === 'merge' && (
        <div className="field">
          <label htmlFor="dc-impl">Кто внедряет</label>
          <MemberSelect id="dc-impl" value={implementer} onChange={setImplementer} empty="Назначу позже" />
          <span className="hint">Если внедряет автор обращения, подтвердить «реализовано» должен руководитель.</span>
        </div>
      )}
    </FormShell>
  );
}

function ImplementerForm({ ctx }: { ctx: ComposerCtx }) {
  const [m, setM] = useState('');
  return (
    <FormShell ctx={ctx} submit="Назначить" disabled={!m} onSubmit={() => void ctx.run('/implementer', { implementer: m }, 'Исполнитель назначен')}>
      <div className="field">
        <label htmlFor="im">Кто внедряет</label>
        <MemberSelect id="im" value={m} onChange={setM} />
      </div>
    </FormShell>
  );
}

function AssignForm({ ctx }: { ctx: ComposerCtx }) {
  const exclude = [ctx.item.author.membershipId, ctx.item.raisedByMembershipId];
  const [m, setM] = useState(ctx.item.maintainer?.membershipId ?? '');
  const [d, setD] = useState(ctx.item.decisionOwner?.membershipId ?? '');
  return (
    <FormShell
      ctx={ctx}
      submit="Назначить"
      disabled={!m && !d}
      onSubmit={() => void ctx.run('/assignments', { ...(m ? { maintainer: m } : {}), ...(d ? { decisionOwner: d } : {}) }, 'Ответственные назначены')}
    >
      <p className="small muted">Автор и тот, с чьих слов записан вопрос, не могут вести или решать его.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="as-m">Ведёт обращение</label>
          <MemberSelect id="as-m" value={m} onChange={setM} exclude={exclude} filter={(r) => r.includes('maintainer')} />
        </div>
        <div className="field">
          <label htmlFor="as-d">Принимает решение</label>
          <MemberSelect id="as-d" value={d} onChange={setD} exclude={exclude} filter={(r) => r.includes('decision_owner')} />
        </div>
      </div>
    </FormShell>
  );
}

function CheckForm({ ctx }: { ctx: ComposerCtx }) {
  const cur = ctx.item.revisions.find((r) => r.number === ctx.item.currentRevision)!;
  const [plan, setPlan] = useState('');
  const [criteria, setCriteria] = useState(cur.success_criteria ?? '');
  const [owner, setOwner] = useState('');
  const sameJudge = ctx.item.decisionOwner?.membershipId === ctx.item.maintainer?.membershipId;
  return (
    <FormShell
      ctx={ctx}
      submit="Начать проверку"
      disabled={plan.trim().length < 10 || criteria.trim().length < 10 || !owner}
      onSubmit={() => void ctx.run('/verifications', { plan: plan.trim(), successCriteria: criteria.trim(), owner }, 'Проверка начата')}
    >
      {sameJudge && (
        <div className="notice warn">
          Для проверки на практике нужен отдельный ответственный за решение: тот, кто проводит проверку, не принимает по ней решение. Сначала назначьте его через «Передать другому».
        </div>
      )}
      <div className="field">
        <label htmlFor="ck-plan">Что и как проверяем</label>
        <textarea id="ck-plan" className="textarea" value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="Например: обновить прошивку на трёх терминалах из восьми и неделю считать зависания" />
      </div>
      <div className="field">
        <label htmlFor="ck-crit">Критерий успеха</label>
        <input id="ck-crit" className="input" value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ck-owner">Кто проводит</label>
        <MemberSelect id="ck-owner" value={owner} onChange={setOwner} exclude={[ctx.item.author.membershipId, ctx.item.decisionOwner?.membershipId]} />
        <span className="hint">Не автор и не тот, кто будет принимать решение.</span>
      </div>
    </FormShell>
  );
}

function EvidenceForm({ ctx, verificationId }: { ctx: ComposerCtx; verificationId: string }) {
  const [kind, setKind] = useState<'baseline' | 'result' | 'positive_observation' | 'negative_observation' | 'reference'>('result');
  const [body, setBody] = useState('');
  const [metric, setMetric] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const num = value.trim() === '' ? undefined : Number(value.replace(',', '.'));
  const ok = body.trim().length >= 1 && (num === undefined || (Number.isFinite(num) && metric.trim().length > 0));
  return (
    <FormShell
      ctx={ctx}
      submit="Записать"
      disabled={!ok}
      onSubmit={() =>
        void ctx.run(
          `/verifications/${verificationId}/evidence`,
          { kind, body: body.trim(), ...(metric.trim() ? { metric: metric.trim() } : {}), ...(num !== undefined ? { value: num } : {}), ...(unit.trim() ? { unit: unit.trim() } : {}) },
          'Результат записан',
        )
      }
    >
      <div className="field">
        <label htmlFor="ev-kind">Что записываем</label>
        <select id="ev-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {(Object.keys(EVIDENCE_LABEL) as (keyof typeof EVIDENCE_LABEL)[]).map((k) => (
            <option key={k} value={k}>
              {EVIDENCE_LABEL[k]}
            </option>
          ))}
        </select>
        <span className="hint">Неудачные наблюдения так же важны, как удачные: они не удаляются и учитываются в решении.</span>
      </div>
      <div className="field">
        <label htmlFor="ev-body">Описание</label>
        <textarea id="ev-body" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="ev-metric">Показатель</label>
          <input id="ev-metric" className="input" value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="зависаний за смену" />
        </div>
        <div className="field">
          <label htmlFor="ev-value">Значение</label>
          <input id="ev-value" className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ev-unit">Единица</label>
          <input id="ev-unit" className="input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="шт" />
        </div>
      </div>
    </FormShell>
  );
}

function ConcludeForm({ ctx, verificationId }: { ctx: ComposerCtx; verificationId: string }) {
  const [outcome, setOutcome] = useState<'positive' | 'negative' | 'inconclusive'>('positive');
  const [t, setT] = useState('');
  return (
    <FormShell ctx={ctx} submit="Подвести итог" disabled={t.trim().length < 10} onSubmit={() => void ctx.run(`/verifications/${verificationId}/conclusion`, { outcome, conclusion: t.trim() }, 'Итог проверки записан')}>
      <div className="segmented" role="group" aria-label="Итог проверки">
        <button type="button" aria-pressed={outcome === 'positive'} onClick={() => setOutcome('positive')}>
          Подтвердилась
        </button>
        <button type="button" aria-pressed={outcome === 'negative'} onClick={() => setOutcome('negative')}>
          Не подтвердилась
        </button>
        <button type="button" aria-pressed={outcome === 'inconclusive'} onClick={() => setOutcome('inconclusive')}>
          Неясно
        </button>
      </div>
      <div className="field">
        <label htmlFor="cc">Вывод</label>
        <textarea id="cc" className="textarea" value={t} onChange={(e) => setT(e.target.value)} />
      </div>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
function Timeline({ item, f, open, org }: { item: IdeaDetail; f: Facts; open: (m: Mode) => void; org: string }) {
  const events = useMemo(() => buildTimeline(item), [item]);
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li className="event" key={e.key} data-tone={e.tone}>
          <div className="what">
            {e.who ? (
              <>
                <b>{e.who}</b> {e.what}
              </>
            ) : (
              <b>{e.what}</b>
            )}
            <time className="when" dateTime={e.at} title={dateTime(e.at)}>
              {ago(e.at)}
            </time>
          </div>
          {e.body && <div className={`body${e.bodyStyle ? ` ${e.bodyStyle}` : ''}`}>{e.body}</div>}
          {e.attachmentId && (
            <button className="btn quiet small file-link" onClick={() => void downloadFile(org, item.number, e.attachmentId!, e.attachmentName!).catch(() => undefined)}>
              {e.attachmentName}
            </button>
          )}
          {e.evidence && <EvidenceList evidence={e.evidence} />}
          {e.review && <ReviewActions r={e.review} f={f} open={open} item={item} />}
          {e.verification && <VerificationActions v={e.verification} f={f} open={open} />}
        </li>
      ))}
    </ol>
  );
}

function EvidenceList({ evidence }: { evidence: Verification['evidence'] }) {
  return (
    <div className="evidence">
      {evidence.map((x) => (
        <div className="evidence-row" key={x.id} data-kind={x.kind}>
          <span className="small">
            <b>{EVIDENCE_LABEL[x.kind]}</b>
            {x.metric && (
              <span className="muted">
                <br />
                {x.metric}
                {x.value !== null ? `: ${String(x.value).replace('.', ',')}${x.unit ? ` ${x.unit}` : ''}` : ''}
              </span>
            )}
          </span>
          <span>
            {x.body}
            <span className="xs faint"> — {x.recordedBy}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ReviewActions({ r, f, open, item }: { r: Review; f: Facts; open: (m: Mode) => void; item: IdeaDetail }) {
  if (r.kind !== 'request_changes' || r.state !== 'open') return null;
  const canResolve = f.resolve || (item.decisionOwner?.membershipId === r.author_membership_id && f.decider);
  return (
    <div className="actions" style={{ marginTop: 8 }}>
      {f.object && (
        <button className="btn small" onClick={() => open(`object:${r.id}`)}>
          Возразить
        </button>
      )}
      {canResolve && (
        <button className="btn small" onClick={() => open(`resolve:${r.id}`)}>
          Закрыть вопрос
        </button>
      )}
    </div>
  );
}

function VerificationActions({ v, f, open }: { v: Verification; f: Facts; open: (m: Mode) => void }) {
  if (v.status !== 'running') return null;
  return (
    <div className="actions" style={{ marginTop: 8 }}>
      {f.evidence(v.owner_membership_id) && (
        <button className="btn small" onClick={() => open(`evidence:${v.id}`)}>
          Добавить результат
        </button>
      )}
      {f.conclude && (
        <button className="btn small" onClick={() => open(`conclude:${v.id}`)}>
          Подвести итог
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function Passport({ item, reload }: { item: IdeaDetail; reload: () => Promise<void> }) {
  const s = useSession();
  const f = facts({ membershipId: s.membershipId, roles: s.roles }, item);
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const fr = due(item.firstResponseDueAt);
  const rd = due(item.resolutionDueAt);
  const credits = item.contributions.filter((c) => c.status !== 'revoked' && c.kind !== 'authorship');

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) await uploadFile(s.org, item.number, file);
      s.toast('Файл приложен');
      await reload();
    } catch (e) {
      s.toast(errorText(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <aside className="passport panel" aria-label="Паспорт обращения">
      <dl>
        <Row k="Автор">
          {item.raisedBy ? (
            <>
              {item.raisedBy}
              <span className="faint"> — записал {item.author.name}</span>
            </>
          ) : (
            item.author.name
          )}
        </Row>
        <Row k="Источник">
          {CHANNEL[item.sourceChannel]}
          {item.sourceNote && <span className="faint">, {item.sourceNote}</span>}
        </Row>
        <Row k="Зарегистрировано">{dateTime(item.publishedAt)}</Row>
        {item.department && <Row k="Подразделение">{item.department}</Row>}
      </dl>
      <hr />
      <dl>
        <Row k="Ведёт">{item.maintainer?.name ?? <span className="flag">не назначен</span>}</Row>
        <Row k="Принимает решение">{item.decisionOwner?.name ?? '—'}</Row>
        {item.implementer && <Row k="Внедряет">{item.implementer}</Row>}
      </dl>
      <hr />
      <dl>
        <Row k="Первый ответ">
          {item.firstResponseAt ? (
            <>получен {ago(item.firstResponseAt)}</>
          ) : fr ? (
            <span className={fr.late ? 'flag red' : ''}>{fr.text}</span>
          ) : (
            '—'
          )}
        </Row>
        {['published', 'review', 'development', 'verification', 'decision'].includes(item.stage) && rd && (
          <Row k="Срок решения">
            <span className={item.overdueResolution ? 'flag red' : ''}>{rd.text}</span>
          </Row>
        )}
        {item.escalations.length > 0 && <Row k="Эскалации">{item.escalations.length}, последняя {ago(item.escalations[item.escalations.length - 1]!.createdAt)}</Row>}
      </dl>
      {credits.length > 0 && (
        <>
          <hr />
          <dl>
            <Row k="Вклад">
              <ul className="plain">
                {credits.map((c, i) => (
                  <li key={i}>
                    {c.member} <span className="faint">— {CREDIT[c.kind] ?? c.kind}</span>
                  </li>
                ))}
              </ul>
            </Row>
          </dl>
        </>
      )}
      {(item.attachments.length > 0 || f.attach) && (
        <>
          <hr />
          <dl>
            <Row k="Файлы">
              <ul className="plain">
                {item.attachments.map((a) => (
                  <li key={a.id}>
                    <button className="btn quiet small file-link" onClick={() => void downloadFile(s.org, item.number, a.id, a.fileName).catch(() => undefined)}>
                      {a.fileName}
                    </button>
                    <span className="faint xs"> {bytes(a.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
              {f.attach && (
                <>
                  <button className="btn small" onClick={() => input.current?.click()} disabled={uploading}>
                    {uploading ? 'Загружаем…' : 'Приложить файл'}
                  </button>
                  <input ref={input} type="file" hidden accept={ACCEPT} multiple onChange={(e) => void attach(e.target.files)} />
                </>
              )}
            </Row>
          </dl>
        </>
      )}
    </aside>
  );
}

const CREDIT: Record<string, string> = {
  issue_found: 'поднял вопрос',
  co_authorship: 'соавтор текста',
  review: 'рецензия',
  verification: 'провёл проверку',
  negative_result: 'отрицательный результат',
  implementation: 'внедрил',
};

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

