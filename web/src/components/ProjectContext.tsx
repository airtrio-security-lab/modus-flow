import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { useSession } from '../lib/session';
import type { EffectLine, IdeaDetail, ItemEffect, Specialists, WorkStage } from '../lib/types';

/**
 * Product refinement (ADR-0031), the pieces shared by the submission form, the Warrior Hall, the item
 * card and the Council: «Где возникла проблема?», the affected departments with a suggestion of whom
 * to invite, and the measured effect. Everything shown comes from the server; nothing is computed here
 * except the wording.
 */
export const WORK_STAGES: [WorkStage, string][] = [
  ['design', 'Проектирование'],
  ['procurement', 'Закупки и поставка'],
  ['installation', 'Монтаж'],
  ['commissioning', 'Пусконаладка'],
  ['operation', 'Эксплуатация'],
  ['internal', 'Внутренние процессы'],
  ['other', 'Другое'],
];

export interface ContextDraft {
  project: string;
  workStage: WorkStage | '';
  affected: string[];
}
export const EMPTY_CONTEXT: ContextDraft = { project: '', workStage: '', affected: [] };
export const contextFilled = (v: ContextDraft) => v.project.trim() !== '' || v.workStage !== '' || v.affected.length > 0;
/** The request body, or nothing when the person left the block empty. */
export const contextBody = (v: ContextDraft) =>
  contextFilled(v)
    ? {
        ...(v.project.trim() ? { project: v.project.trim() } : {}),
        ...(v.workStage ? { workStage: v.workStage } : {}),
        ...(v.affected.length ? { affectedDepartmentIds: v.affected } : {}),
      }
    : undefined;

/** The three optional fields. `responsible` is the department that will answer for the item: it is not offered as «affected». */
export function ContextFields({ value, onChange, responsible, idPrefix = 'ctx' }: { value: ContextDraft; onChange: (v: ContextDraft) => void; responsible?: string; idPrefix?: string }) {
  const s = useSession();
  const departments = (s.directory?.departments ?? []).filter((d) => d.active && d.id !== responsible);
  const toggle = (id: string) => onChange({ ...value, affected: value.affected.includes(id) ? value.affected.filter((x) => x !== id) : [...value.affected, id] });
  return (
    <div className="ctx-fields">
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${idPrefix}-project`}>Проект или объект</label>
          <input id={`${idPrefix}-project`} className="input" value={value.project} maxLength={160} onChange={(e) => onChange({ ...value, project: e.target.value })} placeholder="Например: котельная на Северной" />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-stage`}>Этап работы</label>
          <select id={`${idPrefix}-stage`} className="select" value={value.workStage} onChange={(e) => onChange({ ...value, workStage: e.target.value as WorkStage | '' })}>
            <option value="">Не указан</option>
            {WORK_STAGES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {departments.length > 0 && (
        <fieldset className="ctx-affected">
          <legend>Кого ещё это затрагивает</legend>
          <div className="ctx-chips">
            {departments.slice(0, 24).map((d) => (
              <label key={d.id} data-on={value.affected.includes(d.id) ? 'yes' : 'no'}>
                <input type="checkbox" checked={value.affected.includes(d.id)} disabled={!value.affected.includes(d.id) && value.affected.length >= 8} onChange={() => toggle(d.id)} />
                {d.name}
              </label>
            ))}
          </div>
          <span className="hint">Отвечать за обращение будет подразделение по теме. Отмеченные здесь только названы как затронутые — прав на обращение это не даёт.</span>
        </fieldset>
      )}
    </div>
  );
}

/** «Связать с проектом»: closed by default, so an ordinary idea is filed as fast as before. */
export function ContextDisclosure({ value, onChange, responsible, idPrefix }: { value: ContextDraft; onChange: (v: ContextDraft) => void; responsible?: string; idPrefix?: string }) {
  return (
    <details className="ctx-disclosure" open={contextFilled(value) || undefined}>
      <summary>
        Связать с проектом <span className="muted">— необязательно: где возникла проблема</span>
      </summary>
      <ContextFields value={value} onChange={onChange} responsible={responsible} idPrefix={idPrefix} />
    </details>
  );
}

type ItemPart = Pick<IdeaDetail, 'number' | 'context' | 'author' | 'maintainer' | 'decisionOwner' | 'stage'> & { department?: string | null; raisedByMembershipId?: string | null };

/** On the item card and in the Council: the context, the affected departments, and whom one could invite. */
export function ItemContextPanel({ item, onChanged, council = false }: { item: ItemPart; onChanged: () => void; council?: boolean }) {
  const s = useSession();
  const ctx = item.context;
  const mine = [item.author?.membershipId, item.maintainer?.membershipId, item.decisionOwner?.membershipId, item.raisedByMembershipId].includes(s.membershipId);
  const canWrite = mine && item.stage !== 'closed';
  const [form, setForm] = useState<ContextDraft | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<Specialists | null>(null);
  const has = Boolean(ctx.project || ctx.workStage);
  const affectedIds = ctx.affected.map((a) => a.id);
  const responsible = (s.directory?.departments ?? []).find((d) => d.name === item.department)?.id;
  const options = (s.directory?.departments ?? []).filter((d) => d.active && d.id !== responsible && !affectedIds.includes(d.id));
  const affectedKey = affectedIds.join(',');
  useEffect(() => {
    setWho(null);
    if (!affectedKey) return;
    let alive = true;
    api<Specialists>(`/orgs/${s.org}/ideas/${item.number}/specialists`)
      .then((r) => alive && setWho(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [s.org, item.number, affectedKey]);

  const send = async (path: string, json: unknown, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/orgs/${s.org}/ideas/${item.number}/${path}`, { json });
      s.toast(done);
      setForm(null);
      setAdding('');
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!has && !ctx.affected.length && !canWrite) return null;
  return (
    <section className="panel ctx-panel" aria-labelledby={`ctx-h-${item.number}`}>
      <h2 className="section-title" id={`ctx-h-${item.number}`}>
        Где возникла проблема
      </h2>
      {has ? (
        <dl className="ctx-facts">
          {ctx.project ? (
            <div>
              <dt>Проект или объект</dt>
              <dd>{ctx.project}</dd>
            </div>
          ) : null}
          {ctx.workStageName ? (
            <div>
              <dt>Этап работы</dt>
              <dd>{ctx.workStageName}</dd>
            </div>
          ) : null}
          <div>
            <dt>Указал</dt>
            <dd>{ctx.setBy}</dd>
          </div>
        </dl>
      ) : (
        <p className="small muted">Проект и этап работы не указаны.</p>
      )}
      <div className="ctx-affected-list">
        <h3>Затронутые подразделения</h3>
        {ctx.affected.length ? (
          <ul>
            {ctx.affected.map((a) => (
              <li key={a.id}>
                <a href={`#/castles/${a.id}`}>{a.name}</a> <span className="xs faint">— отметил(а) {a.addedBy}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Не отмечены: вопрос касается одного подразделения.</p>
        )}
        <p className="xs faint">Затронутое подразделение не отвечает за обращение и не получает прав на него. Решение остаётся за назначенным ответственным.</p>
      </div>
      {who && (who.heads.length > 0 || who.specialists.length > 0) ? (
        <div className="ctx-who" aria-label="Кого можно пригласить к обсуждению">
          <h3>Кого можно пригласить к обсуждению</h3>
          <ul>
            {who.heads.map((h) => (
              <li key={h.membershipId}>
                <a href={`#/people/${h.membershipId}`}>{h.name}</a> <span className="xs faint">— руководитель, {h.department}</span>
              </li>
            ))}
            {who.specialists.map((p) => (
              <li key={p.membershipId}>
                <a href={`#/people/${p.membershipId}`}>{p.name}</a> <span className="xs faint">— {p.department}; в анкете: {p.matched.join(', ')}</span>
              </li>
            ))}
          </ul>
          <p className="xs faint">
            Подсказка по правилам, без ИИ. Никто не приглашён и не назначен: заседание созывает тот, у кого есть на это право{council ? '' : ' — в Совете'}. Обсуждение — не разрешение на внедрение.
          </p>
          {!council ? (
            <a className="btn small" href={`#/council/${item.number}`}>
              Открыть обсуждение в Совете
            </a>
          ) : null}
        </div>
      ) : null}
      {canWrite && !form ? (
        <div className="ctx-actions">
          {!has ? (
            <button type="button" className="btn small" onClick={() => setForm(EMPTY_CONTEXT)}>
              Указать проект и этап
            </button>
          ) : null}
          {options.length > 0 ? (
            <form
              className="ctx-add"
              onSubmit={(e) => {
                e.preventDefault();
                if (adding) void send('affected-departments', { departmentId: adding }, 'Подразделение отмечено как затронутое');
              }}
            >
              <label htmlFor={`ctx-add-${item.number}`}>Отметить затронутое подразделение</label>
              <select id={`ctx-add-${item.number}`} className="select" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Выберите…</option>
                {options.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn small" disabled={!adding || busy}>
                Отметить
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {form ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const body = contextBody({ ...form, affected: [] });
            if (body) void send('context', body, 'Проект и этап работы указаны');
          }}
        >
          <ContextFields value={{ ...form, affected: [] }} onChange={(v) => setForm({ ...v, affected: [] })} responsible="-" idPrefix={`ctx-late-${item.number}`} />
          <p className="xs faint">Проект и этап указываются один раз и потом не меняются: так видно, кто и когда их назвал.</p>
          <div className="row">
            <button type="submit" className="btn small primary" disabled={busy || !(form.project.trim() || form.workStage)}>
              Сохранить
            </button>
            <button type="button" className="btn small quiet" onClick={() => setForm(null)}>
              Отмена
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="small" role="alert" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

const fmt = (n: number) => String(n).replace('.', ',');
const REASON: Record<NonNullable<EffectLine['reason']>, string> = {
  no_baseline: 'нет исходного измерения «до»',
  no_result: 'нет измерения «после»',
  units: 'единицы измерения «до» и «после» разные — разницу не считаем',
  conditions: 'измеривший не подтвердил, что период и условия сопоставимы с исходными — разницу не считаем',
};
const VERDICT: Record<NonNullable<EffectLine['verdict']>, string> = { improved: 'Улучшение', worsened: 'Ухудшение', unchanged: 'Без изменений', changed: 'Изменение' };

/** «Измеренный эффект»: before and after of each metric on its own line; no number where there is no comparable pair. */
export function EffectPanel({ effect, implemented }: { effect: ItemEffect; implemented: boolean }) {
  if (!effect.lines.length && !implemented && !effect.approval) return null;
  return (
    <section className="panel effect-panel" aria-labelledby="effect-h">
      <h2 className="section-title" id="effect-h">
        Измеренный эффект
      </h2>
      {!effect.measured ? (
        <p className="effect-none" role="status">
          <b>Эффект пока не измерен.</b> {effect.lines.length ? 'Есть записи, но нет сопоставимой пары «до» и «после».' : 'Нет измерений «до» и «после» — это не ноль, а отсутствие данных.'}
        </p>
      ) : null}
      {effect.lines.length ? (
        <ul className="effect-lines">
          {effect.lines.map((l) => (
            <li key={l.metric} data-state={l.state} data-verdict={l.verdict ?? 'none'}>
              <h3>{l.metric}</h3>
              <div className="effect-pair">
                <Point title="До" p={l.before} />
                <Point title="После" p={l.after} />
                <div className="effect-delta">
                  {l.state === 'measured' ? (
                    <>
                      <b>
                        {l.delta! > 0 ? '+' : l.delta! < 0 ? '−' : ''}
                        {fmt(Math.abs(l.delta!))}
                        {l.before?.unit ? ` ${l.before.unit}` : ''}
                      </b>
                      {l.percent !== null ? <span>{`${l.delta! > 0 ? '+' : l.delta! < 0 ? '−' : ''}${fmt(Math.abs(l.percent))}%`}</span> : <span>процент не считается: исходное значение — ноль</span>}
                      <em>{VERDICT[l.verdict!]}{l.verdict === 'changed' ? ' (направление улучшения не указано)' : ''}</em>
                    </>
                  ) : (
                    <span className="effect-why">{l.state === 'incomparable' ? 'Несопоставимо: ' : 'Не измерено: '}{REASON[l.reason!]}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="xs faint">
        Каждая метрика считается отдельно и ни с чем не складывается. Числа записаны людьми в ходе проверки и не редактируются.
        {effect.approval ? ` Бонус за эффект подтвердил(а) ${effect.approval.by} — это решение ответственного, оно не заменяет измерение.` : ''}
      </p>
    </section>
  );
}

function Point({ title, p }: { title: string; p: EffectLine['before'] }) {
  return (
    <div className="effect-point">
      <span className="xs faint">{title}</span>
      {p ? (
        <>
          <b>
            {fmt(p.value)}
            {p.unit ? ` ${p.unit}` : ''}
          </b>
          {p.period ? <span className="xs">{p.period}</span> : null}
          {p.source ? <span className="xs faint">Источник: {p.source}</span> : null}
          {p.recordedBy ? <span className="xs faint">Записал(а): {p.recordedBy}</span> : null}
        </>
      ) : (
        <span className="muted">нет измерения</span>
      )}
    </div>
  );
}
