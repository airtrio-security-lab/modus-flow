import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, qs } from '../lib/api';
import { due } from '../lib/format';
import { go } from '../lib/router';
import { useSession } from '../lib/session';
import { CHANNEL } from '../lib/status';
import type { Channel, Kind, Status } from '../lib/types';
import { PageHead, StatusChip } from '../components/ui';
import { uploadFile, ACCEPT } from './files';
import { takeShared } from '../lib/share';

interface Created {
  item: { number: number; routed: boolean; maintainer: string | null; firstResponseDueAt: string | null; status: Status };
}
interface Similar {
  number: number;
  title: string;
  status: Status;
  category: string | null;
}

/**
 * Quick submission. One screen, plain words: what happens, optionally how to fix
 * it. Routing (who answers, by when) is decided by the server, not here.
 */
export function NewItem() {
  const s = useSession();
  const dir = s.directory;
  const [kind, setKind] = useState<Kind>('problem');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState('');
  const [proposal, setProposal] = useState('');
  const [criteria, setCriteria] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [onBehalf, setOnBehalf] = useState(false);
  const [channel, setChannel] = useState<Exclude<Channel, 'app'>>('meeting');
  const [raisedBy, setRaisedBy] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<Similar[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [shared, setShared] = useState(false);

  // Text shared from WhatsApp / another app (Android «Поделиться»): prefill and
  // assume it is a colleague's message from a chat; the user can change both.
  useEffect(() => {
    const t = takeShared();
    if (!t) return;
    setProblem(t);
    setOnBehalf(true);
    setChannel('messenger');
    setShared(true);
  }, []);

  // Default department: the employee's own, if it exists in the directory.
  const myDept = useMemo(() => {
    const mine = dir?.members.find((m) => m.membershipId === s.membershipId)?.department;
    return dir?.departments.find((d) => d.active && d.name === mine)?.id ?? '';
  }, [dir, s.membershipId]);
  const dept = departmentId ?? myDept;

  // Similar items while typing, to follow an existing item instead of a duplicate.
  useEffect(() => {
    const q = `${title} ${problem.slice(0, 160)}`.trim();
    if (q.length < 8) {
      setSimilar([]);
      return;
    }
    const t = window.setTimeout(() => {
      api<Similar[]>(`/orgs/${s.org}/ideas/similar${qs({ q: q.slice(0, 480) })}`)
        .then(setSimilar)
        .catch(() => setSimilar([]));
    }, 450);
    return () => window.clearTimeout(t);
  }, [title, problem, s.org]);

  const problems: string[] = [];
  if (title.trim().length < 3) problems.push('коротко назовите вопрос');
  if (problem.trim().length < 20) problems.push('опишите ситуацию (не меньше 20 символов)');
  if (kind === 'idea' && proposal.trim().length < 20) problems.push('опишите предложение (не меньше 20 символов)');
  if (onBehalf && !raisedBy) problems.push('выберите, со слов кого записываете');
  const ready = problems.length === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind,
        title: title.trim(),
        problem: problem.trim(),
        ...(kind === 'idea' ? { proposal: proposal.trim() } : {}),
        ...(criteria.trim().length >= 10 ? { successCriteria: criteria.trim() } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(dept ? { departmentId: dept } : {}),
        sourceChannel: onBehalf ? channel : 'app',
        ...(onBehalf ? { raisedBy, ...(note.trim() ? { sourceNote: note.trim() } : {}) } : {}),
      };
      const r = await api<Created>(`/orgs/${s.org}/ideas`, { json: body });
      const n = r.item.number;
      const failed: string[] = [];
      for (const f of files) {
        try {
          await uploadFile(s.org, n, f);
        } catch (err) {
          failed.push(`${f.name}: ${errorText(err)}`);
        }
      }
      const when = due(r.item.firstResponseDueAt);
      s.toast(
        r.item.routed
          ? `Обращение №${n} зарегистрировано. Ответственный назначен${when ? `, первый ответ ${when.text}` : ''}.`
          : `Обращение №${n} зарегистрировано и передано руководителям для распределения.`,
      );
      if (failed.length) s.toast(`Обращение создано, но не все файлы приложены: ${failed.join('; ')}`);
      go(`/items/${n}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const colleagues = (dir?.members ?? []).filter((m) => m.membershipId !== s.membershipId && m.access === 'member');

  return (
    <form className="stack-lg new-item" onSubmit={(e) => void submit(e)} noValidate>
      <PageHead title="Новое обращение" sub="Своими словами. Ответственного и срок ответа система назначит сама — вы увидите их сразу после отправки.">
        <a className="btn quiet" href="#/meeting">
          Несколько вопросов с совещания или из чата
        </a>
      </PageHead>
      {shared && (
        <div className="notice" role="status">
          Текст из сообщения вставлен. Укажите, чей это вопрос, и коротко назовите его.
        </div>
      )}

      <div className="segmented" role="group" aria-label="Что вы хотите сделать">
        <button type="button" aria-pressed={kind === 'problem'} onClick={() => setKind('problem')}>
          Сообщить о проблеме
        </button>
        <button type="button" aria-pressed={kind === 'idea'} onClick={() => setKind('idea')}>
          Предложить улучшение
        </button>
      </div>

      <div className="stack">
        <div className="field">
          <label htmlFor="problem">{kind === 'problem' ? 'Что происходит?' : 'Что сейчас не так или можно сделать лучше?'}</label>
          <textarea
            id="problem"
            className="textarea"
            rows={4}
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            placeholder="Например: при приёмке большой партии терминалы зависают, коды приходится вводить вручную"
            maxLength={5000}
          />
        </div>
        {kind === 'idea' && (
          <div className="field">
            <label htmlFor="proposal">Что предлагаете?</label>
            <textarea
              id="proposal"
              className="textarea"
              rows={4}
              value={proposal}
              onChange={(e) => setProposal(e.target.value)}
              placeholder="Что сделать, кому и примерно какими силами"
              maxLength={5000}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="title">Коротко, одной строкой</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Терминалы зависают при приёмке" />
        </div>
      </div>

      {similar.length > 0 && (
        <aside className="panel similar" aria-live="polite">
          <h2 className="section-title">Похожие обращения уже есть</h2>
          <p className="small muted">Если это тот же вопрос, откройте обращение и добавьте комментарий — так его решат быстрее.</p>
          <ul>
            {similar.map((x) => (
              <li key={x.number}>
                <a href={`#/items/${x.number}`} target="_blank" rel="noreferrer">
                  №{x.number} {x.title}
                </a>
                <StatusChip status={x.status} />
              </li>
            ))}
          </ul>
        </aside>
      )}

      <div className="grid-2">
        <div className="field">
          <label htmlFor="category">Тема</label>
          <select id="category" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Не знаю — пусть определят</option>
            {dir?.categories
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <span className="hint">По теме выбирается ответственный.</span>
        </div>
        <div className="field">
          <label htmlFor="department">Где это происходит</label>
          <select id="department" className="select" value={dept} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Не относится к подразделению</option>
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

      <div className="field">
        <label htmlFor="criteria">Как поймём, что вопрос решён? (необязательно)</label>
        <input
          id="criteria"
          className="input"
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          maxLength={3000}
          placeholder="Например: приёмка машины без зависаний и ручного ввода"
        />
      </div>

      <div className="stack">
        <label className="check">
          <input type="checkbox" checked={onBehalf} onChange={(e) => setOnBehalf(e.target.checked)} />
          <span>
            Записываю со слов коллеги
            <span className="hint"> — вопрос прозвучал на совещании, по телефону, в почте или устно</span>
          </span>
        </label>
        {onBehalf && (
          <div className="panel stack">
            <div className="grid-2">
              <div className="field">
                <label htmlFor="raisedBy">Чей это вопрос</label>
                <select id="raisedBy" className="select" value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)}>
                  <option value="">Выберите сотрудника</option>
                  {colleagues.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.name}
                      {m.department ? `, ${m.department}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="channel">Откуда вопрос</label>
                <select id="channel" className="select" value={channel} onChange={(e) => setChannel(e.target.value as Exclude<Channel, 'app'>)}>
                  {(Object.keys(CHANNEL) as Channel[])
                    .filter((c) => c !== 'app')
                    .map((c) => (
                      <option key={c} value={c}>
                        {CHANNEL[c]}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="note">Где и когда прозвучал (необязательно)</label>
              <input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Планёрка склада, 10 ноября" />
            </div>
            <p className="small muted">Коллега получит уведомление, обращение появится в его списке, а заслуга «поднял вопрос» останется за ним.</p>
          </div>
        )}
      </div>

      <div className="field">
        <span className="label">Фото или документы (необязательно)</span>
        <div className="row">
          <button type="button" className="btn small" onClick={() => fileInput.current?.click()}>
            Выбрать файлы
          </button>
          <span className="hint">PNG, JPEG, WEBP, PDF, TXT, DOCX, XLSX — до 5 МБ каждый</span>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 10))}
        />
        {files.length > 0 && (
          <ul className="files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`}>
                {f.name}
                <button type="button" className="btn quiet small" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  Убрать
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="submit-bar">
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          {busy ? 'Отправляем…' : 'Отправить обращение'}
        </button>
        {!ready && <span className="small muted">Осталось: {problems.join(', ')}.</span>}
        {ready && <span className="small muted">После отправки текст правится только новой версией — история сохраняется.</span>}
      </div>
    </form>
  );
}
