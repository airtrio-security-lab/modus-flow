import { useEffect, useState, type ReactNode } from 'react';
import { api, errorText, newKey } from '../lib/api';
import { dateTime } from '../lib/format';
import { go } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import type { AdvisorStatus, Kind, ProtocolCandidate, ProtocolRow, ProtocolView } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';
import { useAdvisorStatus } from '../components/Advisor';

/**
 * «Протокол целиком» (MODUS ADVISOR, ADR-0013): the whole meeting protocol is
 * kept verbatim; the assistant marks the lines that read like tasks, and a
 * lead confirms each one — kind, wording, who raised it — before it becomes an
 * item. Without a connected model the marking is a rule-based template and
 * the page says so in plain words.
 */
export function MeetingModes({ active }: { active: 'rows' | 'protocol' }) {
  const s = useSession();
  if (!s.isLead && !s.isAdmin) return null;
  return (
    <nav className="segmented" aria-label="Как разобрать встречу">
      <a href="#/meeting" aria-current={active === 'rows' ? 'page' : undefined} aria-pressed={active === 'rows'}>
        По одному вопросу
      </a>
      <a href="#/meeting/protocol" aria-current={active === 'protocol' ? 'page' : undefined} aria-pressed={active === 'protocol'}>
        Протокол целиком
      </a>
    </nav>
  );
}

export const SAMPLE_PROTOCOL = `Планёрка склада, 12 ноября
Присутствовали: Олег Киселев, Асель Темирова, Руслан Исаев, Дмитрий Орлов

Асель Темирова: этикетки приходится печатать на отдельном компьютере, на каждую машину уходит 3–4 минуты.
Руслан Исаев: сканер у ворот №2 зависает на холоде, вводим коды вручную.
Олег Киселев: обсудили график смен, вопросов нет.

Решили:
- Проверить печать этикеток со сканера на мобильный принтер у ворот
- Купить запасной принтер для ворот №1 (поднял: Руслан Исаев)

Разное:
Следующая планёрка в пятницу.`;

export function ProtocolPage({ id }: { id?: string }) {
  const s = useSession();
  if (!s.isLead && !s.isAdmin) {
    return (
      <div className="empty">
        Протоколы совещаний разбирают руководители и ведущие обращений. Вопрос можно подать самому: <a href="#/new">«Подать обращение»</a>.
      </div>
    );
  }
  return id ? <ProtocolDetail id={id} key={id} /> : <ProtocolNew />;
}

function MethodNote({ status }: { status: AdvisorStatus | null }) {
  if (!status) return null;
  return <p className="small muted">{status.note}</p>;
}

function ProtocolNew() {
  const s = useSession();
  const status = useAdvisorStatus();
  const list = useLoad(() => api<ProtocolRow[]>(`/orgs/${s.org}/protocols`), [s.org]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [method, setMethod] = useState<'rules' | 'model'>('rules');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const modelReady = !!status?.model.configured && status.model.reachable;

  async function parse(e: React.FormEvent) {
    e.preventDefault();
    if (busy || title.trim().length < 3 || text.length < 20) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string; candidates: number; dropped: number }>(`/orgs/${s.org}/protocols`, { key, json: { title: title.trim(), text, method } });
      s.toast(
        r.candidates
          ? `Найдено пунктов: ${r.candidates}${r.dropped ? `; отброшено ${r.dropped} без точной цитаты` : ''}. Проверьте каждый`
          : 'Похожих на задачи строк не нашлось — текст сохранён',
      );
      go(`/meeting/protocol/${r.id}`);
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  }

  return (
    <div className="stack-lg">
      <PageHead
        title="Разбор совещания"
        sub="Вставьте протокол целиком. Помощник отметит строки, похожие на проблемы, предложения и поручения; каждую вы проверите и подтвердите сами."
      />
      <MeetingModes active="protocol" />
      <form className="panel stack" onSubmit={(e) => void parse(e)} noValidate>
        <div className="field">
          <label htmlFor="pr-title">Какая встреча</label>
          <input id="pr-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Планёрка склада, 12 ноября" />
        </div>
        <div className="field">
          <div className="spread">
            <label htmlFor="pr-text">Текст протокола</label>
            <button
              type="button"
              className="btn quiet small"
              onClick={() => {
                setText(SAMPLE_PROTOCOL);
                if (!title.trim()) setTitle('Планёрка склада, 12 ноября');
              }}
            >
              Подставить пример (вымышленный)
            </button>
          </div>
          <textarea id="pr-text" className="textarea mono-ish" rows={12} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} />
          <span className="hint">
            Текст сохраняется без изменений вместе с контрольной суммой — это исходное свидетельство. {text.length.toLocaleString('ru-RU')} / 20 000
          </span>
        </div>
        <fieldset className="field">
          <legend>Как искать задачи</legend>
          <label className="check">
            <input type="radio" name="pr-method" checked={method === 'rules'} onChange={() => setMethod('rules')} /> Разбор по шаблону (без ИИ): строки
            с «решили», «нужно», «не работает», «предлагаю» и пункты под «Решили:»
          </label>
          <label className="check">
            <input type="radio" name="pr-method" checked={method === 'model'} disabled={!modelReady} onChange={() => setMethod('model')} /> {status?.model.remote ? 'Облачная модель' : 'Локальная модель'}
            {status?.model.configured ? ` ${status.model.model}` : ''}
            {!status?.model.configured ? ' — не подключена' : !status.model.reachable ? ' — не отвечает' : ''}
            {status?.model.configured && status.model.remote ? ' — текст протокола будет отправлен за пределы компании' : ''}
          </label>
          <MethodNote status={status} />
        </fieldset>
        {err ? <p className="notice error">{err}</p> : null}
        <div className="submit-bar">
          <button type="submit" className="btn primary" disabled={busy || title.trim().length < 3 || text.length < 20}>
            {busy ? 'Ищем…' : 'Найти задачи в протоколе'}
          </button>
          <span className="small muted">Пока вы не подтвердите пункт, обращение не создаётся и никто не получает уведомлений.</span>
        </div>
      </form>

      <section className="panel stack">
        <h2 className="section-title">Разобранные протоколы</h2>
        {list.error ? <ErrorBox error={list.error} retry={() => void list.reload()} /> : null}
        {list.data?.length ? (
          <ul className="realm-envoys">
            {list.data.map((p) => (
              <li key={p.id}>
                <a href={`#/meeting/protocol/${p.id}`}>{p.title}</a>
                <span className="small muted">
                  {dateTime(p.createdAt)}, {p.createdBy}. Пунктов: {p.total}, подтверждено: {p.accepted}, ждут проверки: {p.proposed}.{' '}
                  {p.method === 'rules' ? 'По шаблону, без ИИ' : `Модель ${p.model}`}
                </span>
              </li>
            ))}
          </ul>
        ) : list.data ? (
          <p className="small muted">Пока ни одного протокола.</p>
        ) : null}
      </section>
    </div>
  );
}

/** Source text with the found quotes marked and numbered. */
function MarkedText({ text, candidates }: { text: string; candidates: ProtocolCandidate[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const k of [...candidates].sort((a, b) => a.quoteStart - b.quoteStart)) {
    if (k.quoteStart < at) continue;
    parts.push(text.slice(at, k.quoteStart));
    parts.push(
      <mark key={k.id} id={`quote-${k.ord}`} className={`quote is-${k.status}`} title={`Пункт ${k.ord}`}>
        <sup>{k.ord}</sup>
        {text.slice(k.quoteStart, k.quoteEnd)}
      </mark>,
    );
    at = k.quoteEnd;
  }
  parts.push(text.slice(at));
  return <pre className="protocol-text">{parts}</pre>;
}

function ProtocolDetail({ id }: { id: string }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<ProtocolView>(`/orgs/${s.org}/protocols/${id}`), [s.org, id]);
  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Открываем протокол…" />;
  if (!data) return null;
  const left = data.candidates.filter((k) => k.status === 'proposed').length;
  return (
    <div className="stack-lg">
      <PageHead title={data.title} sub={`${dateTime(data.createdAt)}, разобрал(а) ${data.createdBy}`}>
        <a className="btn" href="#/meeting/protocol">
          Новый протокол
        </a>
      </PageHead>
      <MeetingModes active="protocol" />
      <section className="council-status panel">
        <div>
          <span className="label">Как найдено</span>
          <b>{data.methodLabel}{data.model ? `: ${data.model}` : ''}</b>
        </div>
        <div>
          <span className="label">Пунктов</span>
          <b>{data.candidates.length}</b>
        </div>
        <div>
          <span className="label">Ждут проверки</span>
          <b>{left}</b>
        </div>
        <div>
          <span className="label">Контрольная сумма</span>
          <b title={data.sha256}>SHA-256 {data.sha256.slice(0, 12)}…</b>
        </div>
        <p className="small muted council-note">
          {data.method === 'rules'
            ? 'Строки отмечены по шаблону (ключевые слова и раздел «Решили:»), это не ИИ. Шаблон пропускает задачи, сказанные другими словами, — их добавьте на вкладке «По одному вопросу».'
            : 'Пункты предложены локальной моделью; оставлены только те, чья цитата дословно есть в тексте.'}
        </p>
      </section>
      <div className="protocol">
        <section className="panel stack" aria-labelledby="src-h">
          <h2 id="src-h" className="section-title">
            Исходный текст
          </h2>
          <MarkedText text={data.text} candidates={data.candidates} />
        </section>
        <div className="stack">
          {data.candidates.length ? (
            data.candidates.map((k) => <CandidateCard key={k.id} protocol={data} k={k} onDone={reload} />)
          ) : (
            <p className="panel small">В тексте не нашлось строк, похожих на задачи. Протокол сохранён; вопросы можно записать по одному.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Text of the quote without "Имя Фамилия:" and the bullet: the wording a person then checks. */
const contentOf = (quote: string) =>
  quote
    .replace(/^(?:[-–—•*·]|\d{1,2}[.)])\s+/, '')
    .replace(/^[А-ЯЁA-Z][а-яёa-z-]+(?:\s+[А-ЯЁA-Z][а-яёa-z-]+)?\s*:\s+/, '')
    .replace(/\s*\((?:поднял[аи]?|предложил[аи]?|автор)\s*:?[^)]*\)/, '')
    .trim();
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function CandidateCard({ protocol, k, onDone }: { protocol: ProtocolView; k: ProtocolCandidate; onDone: () => Promise<void> }) {
  const s = useSession();
  const dir = s.directory;
  const members = (dir?.members ?? []).filter((m) => m.access === 'member' && m.membershipId !== s.membershipId);
  const guess = k.raiser ? members.find((m) => m.name.toLowerCase() === k.raiser!.toLowerCase()) : undefined;
  const [kind, setKind] = useState<Kind>(k.kind);
  const [title, setTitle] = useState(k.title);
  // For a proposal the protocol rarely says what is wrong now: the person writes it, nothing is invented.
  const [problem, setProblem] = useState(k.kind === 'problem' ? cap(contentOf(k.quote)) : '');
  const [proposal, setProposal] = useState(k.kind === 'idea' ? cap(contentOf(k.quote)) : '');
  const [raisedBy, setRaisedBy] = useState(guess?.membershipId ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRaisedBy((cur) => cur || guess?.membershipId || ''), [guess?.membershipId]);

  const short = problem.trim().length < 20 || (kind === 'idea' && proposal.trim().length < 20) || title.trim().length < 3;
  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ item: { number: number } }>(`/orgs/${s.org}/protocols/${protocol.id}/candidates/${k.id}/accept`, {
        key,
        json: {
          kind,
          title: title.trim(),
          problem: problem.trim(),
          ...(kind === 'idea' ? { proposal: proposal.trim() } : {}),
          ...(categoryId ? { categoryId } : {}),
          ...(departmentId ? { departmentId } : {}),
          ...(raisedBy ? { raisedBy } : {}),
        },
      });
      s.toast(`Пункт ${k.ord} подтверждён: обращение №${r.item.number}`);
      await onDone();
      void s.refreshInbox();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  async function dismiss() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/protocols/${protocol.id}/candidates/${k.id}/dismiss`, { json: {} });
      s.toast(`Пункт ${k.ord}: не задача`);
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }

  const f = (name: string) => `c${k.ord}-${name}`;
  return (
    <article className="panel stack candidate" data-status={k.status} aria-labelledby={f('h')}>
      <div className="spread">
        <h2 id={f('h')} className="section-title">
          Пункт {k.ord}
        </h2>
        <a className="small" href={`#quote-${k.ord}`} onClick={(e) => { e.preventDefault(); document.getElementById(`quote-${k.ord}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>
          Показать в тексте
        </a>
      </div>
      <blockquote className="quote-block">
        {k.quote}
        <footer className="small muted">Цитата из протокола, символы {k.quoteStart + 1}–{k.quoteEnd}</footer>
      </blockquote>
      {k.status === 'accepted' ? (
        <p className="small">
          Подтвердил(а) {k.decidedBy}: <a href={`#/items/${k.itemNumber}`}>обращение №{k.itemNumber}</a>
        </p>
      ) : k.status === 'dismissed' ? (
        <p className="small muted">Не задача — решил(а) {k.decidedBy}</p>
      ) : !protocol.canDecide ? (
        <p className="small muted">Ждёт проверки руководителем.</p>
      ) : (
        <>
          <div className="segmented" role="radiogroup" aria-label="Что это">
            {(['problem', 'idea'] as const).map((x) => (
              <button key={x} type="button" role="radio" aria-checked={kind === x} aria-pressed={kind === x} onClick={() => setKind(x)}>
                {x === 'problem' ? 'Проблема' : 'Предложение'}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor={f('t')}>Название</label>
            <input id={f('t')} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
          </div>
          <div className="field">
            <label htmlFor={f('p')}>{kind === 'problem' ? 'Что не так — проверьте формулировку' : 'Что сейчас не так'}</label>
            <textarea id={f('p')} className="textarea" rows={2} value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={5000} placeholder={kind === 'idea' ? 'В протоколе не сказано — опишите со слов участников' : undefined} />
          </div>
          {kind === 'idea' ? (
            <div className="field">
              <label htmlFor={f('o')}>Что предлагают</label>
              <textarea id={f('o')} className="textarea" rows={2} value={proposal} onChange={(e) => setProposal(e.target.value)} maxLength={5000} />
            </div>
          ) : null}
          <div className="grid-2">
            <div className="field">
              <label htmlFor={f('w')}>Кто поднял</label>
              <select id={f('w')} className="select" value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)}>
                <option value="">Я сам / не указано</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                    {m.department ? `, ${m.department}` : ''}
                  </option>
                ))}
              </select>
              <span className="hint">
                {k.raiser ? `В протоколе: «${k.raiser}»${guess ? '' : ' — в справочнике не найден, выберите сами'}` : 'В протоколе не указано'}
              </span>
            </div>
            <div className="field">
              <label htmlFor={f('c')}>Тема</label>
              <select id={f('c')} className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Пусть определят</option>
                {dir?.categories
                  .filter((c) => c.active)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor={f('d')}>Подразделение</label>
            <select id={f('d')} className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Не относится к одному</option>
              {dir?.departments
                .filter((d) => d.active)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </div>
          {err ? <p className="notice error">{err}</p> : null}
          <div className="row">
            <button type="button" className="btn primary" disabled={busy || short} onClick={() => void accept()}>
              {busy ? 'Сохраняем…' : 'Подтвердить и зарегистрировать'}
            </button>
            <button type="button" className="btn quiet" disabled={busy} onClick={() => void dismiss()}>
              Не задача
            </button>
          </div>
          {short ? <span className="hint">Описание — от 20 символов{kind === 'idea' ? ', предложение тоже' : ''}.</span> : null}
        </>
      )}
    </article>
  );
}
