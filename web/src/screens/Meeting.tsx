import { useState } from 'react';
import { api, errorText, newKey } from '../lib/api';
import { useSession } from '../lib/session';
import { STATUS } from '../lib/status';
import type { Status } from '../lib/types';
import { PageHead } from '../components/ui';
import { plural } from '../lib/format';
import { MeetingModes } from './Protocol';

/**
 * «Разбор совещания»: questions heard at a meeting (or in a chat thread, or a
 * long e-mail) are recorded in one go. Each becomes its own item with its own
 * owner and deadline; the person who raised it keeps the credit.
 */
type Source = 'meeting' | 'messenger' | 'email';
const SOURCES: { id: Source; label: string; placeholder: string }[] = [
  { id: 'meeting', label: 'Совещание', placeholder: 'Планёрка склада' },
  { id: 'messenger', label: 'Чат в мессенджере', placeholder: 'Чат «Склад» в WhatsApp' },
  { id: 'email', label: 'Письмо', placeholder: 'Письмо от отдела продаж' },
];

interface Row {
  id: string;
  key: string; // idempotency key; renewed when the text changes
  raisedBy: string; // '' = I raised it myself
  text: string;
  categoryId: string;
  state: 'draft' | 'sending' | 'done' | 'error';
  number?: number;
  status?: Status;
  error?: string;
}
const emptyRow = (): Row => ({ id: newKey(), key: newKey(), raisedBy: '', text: '', categoryId: '', state: 'draft' });

/** First sentence (or the first words) as the one-line title. */
export function titleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const sentence = t.split(/(?<=[.!?…])\s/)[0] ?? t;
  if (sentence.length <= 90) return sentence.replace(/[.…]+$/, '');
  const cut = sentence.slice(0, 90);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 90)}…`;
}

export function Meeting() {
  const s = useSession();
  const dir = s.directory;
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const [source, setSource] = useState<Source>('meeting');
  const [name, setName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [running, setRunning] = useState(false);

  const src = SOURCES.find((x) => x.id === source)!;
  const edit = (id: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch, ...(patch.text !== undefined || patch.raisedBy !== undefined || patch.categoryId !== undefined ? { key: newKey(), state: r.state === 'done' ? 'done' : 'draft', error: undefined } : {}) } : r)));
  const filled = rows.filter((r) => r.text.trim().length > 0 && r.state !== 'done');
  const invalid = filled.filter((r) => r.text.trim().length < 20);
  const done = rows.filter((r) => r.state === 'done');
  const colleagues = (dir?.members ?? []).filter((m) => m.membershipId !== s.membershipId && m.access === 'member');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running || !filled.length || invalid.length || !name.trim()) return;
    setRunning(true);
    const note = `${name.trim()}, ${today}`.slice(0, 300);
    for (const r of filled) {
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, state: 'sending', error: undefined } : x)));
      try {
        const res = await api<{ item: { number: number; status: Status } }>(`/orgs/${s.org}/ideas`, {
          key: r.key,
          json: {
            kind: 'problem',
            title: titleFrom(r.text),
            problem: r.text.trim(),
            ...(r.categoryId ? { categoryId: r.categoryId } : {}),
            ...(departmentId ? { departmentId } : {}),
            sourceChannel: source,
            sourceNote: note,
            ...(r.raisedBy ? { raisedBy: r.raisedBy } : {}),
          },
        });
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, state: 'done', number: res.item.number, status: res.item.status } : x)));
      } catch (err) {
        setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, state: 'error', error: errorText(err) } : x)));
      }
    }
    setRunning(false);
    void s.refreshInbox();
  }

  return (
    <form className="stack-lg meeting" onSubmit={(e) => void submit(e)} noValidate>
      <PageHead
        title="Разбор совещания"
        sub="Все вопросы с одной встречи, из чата или письма — за один раз. Каждый станет отдельным обращением со своим ответственным и сроком, а заслуга останется за тем, кто его поднял."
      />
      <MeetingModes active="rows" />

      <div className="stack">
        <div className="segmented" role="group" aria-label="Откуда вопросы">
          {SOURCES.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === source} onClick={() => setSource(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="mt-name">{source === 'meeting' ? 'Какая встреча' : source === 'messenger' ? 'Какой чат' : 'Какое письмо'}</label>
            <input id="mt-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={src.placeholder} />
            <span className="hint">Запишется в источник каждого обращения вместе с датой: {today}.</span>
          </div>
          <div className="field">
            <label htmlFor="mt-dept">Где это происходит</label>
            <select id="mt-dept" className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Не относится к одному подразделению</option>
              {dir?.departments
                .filter((d) => d.active)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
      </div>

      <ol className="meeting-rows">
        {rows.map((r, i) => (
          <li key={r.id} className="panel stack" data-state={r.state}>
            <div className="spread">
              <h2 className="section-title">Вопрос {i + 1}</h2>
              {r.state === 'done' ? (
                <a href={`#/items/${r.number}`} className="small">
                  Обращение №{r.number}: {r.status ? STATUS[r.status].label.toLowerCase() : 'зарегистрировано'}
                </a>
              ) : (
                rows.length > 1 && (
                  <button type="button" className="btn quiet small" onClick={() => setRows(rows.filter((x) => x.id !== r.id))} disabled={running}>
                    Убрать
                  </button>
                )
              )}
            </div>
            <div className="field">
              <label htmlFor={`mt-text-${r.id}`} className="sr-only">
                Вопрос {i + 1}
              </label>
              <textarea
                id={`mt-text-${r.id}`}
                className="textarea"
                rows={3}
                value={r.text}
                readOnly={r.state === 'done'}
                onChange={(e) => edit(r.id, { text: e.target.value })}
                placeholder="Что прозвучало: проблема или предложение своими словами"
                maxLength={5000}
              />
              {r.text.trim().length > 0 && r.state !== 'done' && (
                <span className="hint">{r.text.trim().length < 20 ? `Ещё ${20 - r.text.trim().length} симв. — опишите чуть подробнее` : `Название: ${titleFrom(r.text)}`}</span>
              )}
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`mt-who-${r.id}`}>Кто поднял</label>
                <select id={`mt-who-${r.id}`} className="select" value={r.raisedBy} disabled={r.state === 'done'} onChange={(e) => edit(r.id, { raisedBy: e.target.value })}>
                  <option value="">Я сам</option>
                  {colleagues.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.name}
                      {m.department ? `, ${m.department}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor={`mt-cat-${r.id}`}>Тема</label>
                <select id={`mt-cat-${r.id}`} className="select" value={r.categoryId} disabled={r.state === 'done'} onChange={(e) => edit(r.id, { categoryId: e.target.value })}>
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
            {r.state === 'error' && (
              <div className="notice error" role="alert">
                Не зарегистрирован: {r.error}
              </div>
            )}
          </li>
        ))}
      </ol>

      <div>
        <button type="button" className="btn" onClick={() => setRows([...rows, emptyRow()])} disabled={running}>
          Добавить вопрос
        </button>
      </div>

      <div className="submit-bar">
        <button type="submit" className="btn primary" disabled={running || !filled.length || invalid.length > 0 || !name.trim()}>
          {running ? 'Регистрируем…' : filled.length > 1 ? `Зарегистрировать ${filled.length} ${plural(filled.length, 'обращение', 'обращения', 'обращений')}` : 'Зарегистрировать обращение'}
        </button>
        <span className="small muted">
          {done.length > 0 && filled.length === 0
            ? `Готово: ${done.length}. Авторы получили уведомления, ответственные назначены.`
            : !name.trim()
              ? `Укажите, ${source === 'meeting' ? 'какая была встреча' : source === 'messenger' ? 'из какого чата вопросы' : 'какое письмо'}.`
              : invalid.length
                ? 'Некоторые вопросы слишком короткие.'
                : 'Каждый вопрос регистрируется отдельно: если один не пройдёт, остальные сохранятся, а его можно исправить и отправить снова.'}
        </span>
      </div>
    </form>
  );
}
