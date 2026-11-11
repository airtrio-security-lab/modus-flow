import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, getToken, newKey } from '../lib/api';
import { dateTime } from '../lib/format';
import { go } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import { DEMO_TRANSCRIPT } from '../lib/demoMeeting';
import type { Consent, FindingType, Kind, MeetingFinding, MeetingRow, MeetingView } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/**
 * Council meetings with recording (ADR-0014). Recording needs the consent of
 * every participant (the database refuses otherwise); the indicator is always
 * visible while recording; the transcript says where it came from; findings are
 * proposals until a lead participant confirms them.
 */
export const hashParams = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const CONSENT: Record<Consent, { label: string; tone: string }> = {
  pending: { label: 'ждём ответа', tone: 'mid' },
  given: { label: 'согласие дано', tone: 'pro' },
  declined: { label: 'отказ', tone: 'con' },
};
export const FINDING_LABEL: Record<FindingType, string> = {
  idea: 'Идея',
  problem: 'Проблема',
  task: 'Поручение',
  deadline: 'Срок',
  owner_candidate: 'Возможный ответственный',
  proposed_solution: 'Вариант решения',
  decision: 'Решение',
  risk: 'Риск',
  objection: 'Возражение',
  open_question: 'Открытый вопрос',
  insight: 'Наблюдение',
};
const ITEM_TYPES: FindingType[] = ['idea', 'problem', 'task', 'proposed_solution', 'decision'];
const CONF = { high: 'уверенность высокая', medium: 'уверенность средняя', low: 'уверенность низкая' } as const;
const SOURCE_LABEL = {
  engine: (e: string | null) => `Расшифровано движком ${e ?? ''} на этом компьютере`,
  manual: () => 'Расшифровка введена вручную',
  prepared: () => 'Подготовленная расшифровка для демонстрации — не распознана из этой записи',
  minutes: () => 'Письменный протокол заседания — запись не велась',
} as const;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
export function MeetingsList() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<MeetingRow[]>(`/orgs/${s.org}/meetings`), [s.org]);
  return (
    <div className="stack-lg">
      <PageHead title="Заседания Совета" sub="Совещания с записью: только с согласия всех участников. Видят их только участники.">
        {s.isLead || s.isAdmin ? (
          <a className="btn primary" href="#/meetings/new">
            Созвать заседание
          </a>
        ) : null}
      </PageHead>
      <CouncilTabs active="meetings" />
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading /> : null}
      {data ? (
        data.length ? (
          <div className="list">
            {data.map((m) => (
              <a key={m.id} className="list-row" href={`#/meetings/${m.id}`}>
                <span className="num">{m.scope === 'castle' ? 'Малый совет' : 'Королевский совет'}</span>
                <span className="title">{m.title}</span>
                <span className="meta">
                  <span>Созвал(а) {m.organizer}, {dateTime(m.createdAt)}</span>
                  {m.department ? <span>Замок «{m.department}»</span> : null}
                  {m.ideaNumber ? <span>Обращение №{m.ideaNumber}</span> : null}
                  <span>
                    Согласие: {m.consented} из {m.participants}
                  </span>
                  <span>{m.hasRecording ? 'запись сохранена' : m.recordingStartedAt ? 'идёт запись' : 'записи нет'}</span>
                  {m.myConsent === 'pending' ? <span className="flag">ждёт вашего ответа</span> : null}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="empty">Заседаний пока нет. Их созывают руководители из Совета или из замка подразделения.</div>
        )
      ) : null}
    </div>
  );
}

export function CouncilTabs({ active }: { active: 'items' | 'meetings' }) {
  return (
    <nav className="segmented" aria-label="Совет">
      <a href="#/council" aria-pressed={active === 'items'} aria-current={active === 'items' ? 'page' : undefined}>
        Обращения на Совете
      </a>
      <a href="#/meetings" aria-pressed={active === 'meetings'} aria-current={active === 'meetings' ? 'page' : undefined}>
        Заседания с записью
      </a>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Calling a meeting
// ---------------------------------------------------------------------------
export function NewMeeting() {
  const s = useSession();
  const q = hashParams();
  const dir = s.directory;
  const [title, setTitle] = useState(q.get('title') ?? '');
  const [departmentId, setDepartmentId] = useState(q.get('department') ?? '');
  const ideaNumber = Number(q.get('idea')) || undefined;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [consent, setConsent] = useState(false);
  const [when, setWhen] = useState('');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const members = (dir?.members ?? []).filter((m) => m.access === 'member' && m.membershipId !== s.membershipId);
  const dept = dir?.departments.find((d) => d.id === departmentId);
  useEffect(() => {
    // A castle's small council starts with the people of that department.
    if (dept && picked.size === 0) setPicked(new Set(members.filter((m) => m.department === dept.name).map((m) => m.membershipId)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept?.id]);
  if (!s.isLead && !s.isAdmin) return <div className="empty">Заседание созывает руководитель или ведущий обращений.</div>;
  const shown = members.filter((m) => !filter.trim() || `${m.name} ${m.department ?? ''} ${m.jobTitle ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || title.trim().length < 3 || !picked.size || !consent) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>(`/orgs/${s.org}/meetings`, {
        key,
        json: {
          title: title.trim(),
          participants: [...picked],
          organizerConsent: true,
          ...(departmentId ? { departmentId } : {}),
          ...(ideaNumber ? { ideaNumber } : {}),
          ...(when ? { scheduledAt: new Date(when).toISOString() } : {}),
        },
      });
      s.toast('Заседание созвано: участники получили уведомление и запрос согласия');
      go(`/meetings/${r.id}`);
    } catch (x) {
      setErr(errorText(x));
      setBusy(false);
    }
  }
  return (
    <form className="stack-lg" onSubmit={(e) => void submit(e)} noValidate>
      <PageHead title="Созвать заседание" sub="Участники получат уведомление. Запись начнётся только после согласия каждого — без исключений." />
      <section className="panel stack">
        <div className="field">
          <label htmlFor="mt-title">Тема</label>
          <input id="mt-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Планёрка склада: приёмка и этикетки" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="mt-scope">Совет</label>
            <select id="mt-scope" className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Королевский совет (межотдельский)</option>
              {dir?.departments
                .filter((d) => d.active)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    Малый совет замка «{d.name}»
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="mt-when">Когда</label>
            <input id="mt-when" className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <span className="hint">Можно назначить позже; участники получат сообщение о переносе.</span>
          </div>
          <div className="field">
            <span className="label-like">Обращение</span>
            <p className="small">{ideaNumber ? <a href={`#/items/${ideaNumber}`}>№{ideaNumber}</a> : 'не привязано'}</p>
          </div>
        </div>
      </section>
      <fieldset className="panel stack">
        <legend className="section-title">Участники: {picked.size}</legend>
        <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Найти по имени, подразделению, должности" aria-label="Найти участника" />
        <ul className="pick-list">
          {shown.map((m) => (
            <li key={m.membershipId}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={picked.has(m.membershipId)}
                  onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(m.membershipId);
                    else n.delete(m.membershipId);
                    setPicked(n);
                  }}
                />
                <span>
                  {m.name}
                  <span className="muted">{[m.jobTitle, m.department].filter(Boolean).length ? `, ${[m.jobTitle, m.department].filter(Boolean).join(', ')}` : ''}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <section className="panel stack">
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Я согласен(на) на запись этого заседания и
          предупрежу участников вслух в начале.
        </label>
        <p className="small muted">
          Запись хранится в системе и доступна только участникам. Скрытой записи нет: индикатор виден всё время, пока идёт запись.
        </p>
        {err ? <p className="notice error">{err}</p> : null}
        <div>
          <button type="submit" className="btn primary" disabled={busy || title.trim().length < 3 || !picked.size || !consent}>
            {busy ? 'Созываем…' : 'Созвать заседание'}
          </button>
        </div>
      </section>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Meeting page
// ---------------------------------------------------------------------------
export function MeetingPage({ id }: { id: string }) {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<MeetingView>(`/orgs/${s.org}/meetings/${id}`), [s.org, id]);
  const player = useRef<HTMLAudioElement | null>(null);
  const seek = (ms: number) => {
    const a = player.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    void a.play().catch(() => undefined);
    a.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };
  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (loading && !data) return <Loading label="Открываем заседание…" />;
  if (!data) return null;
  const transcript = data.transcripts.at(-1) ?? null;
  const organizer = data.organizerMembershipId === s.membershipId;
  const waiting = data.participants.filter((p) => p.consent !== 'given');
  return (
    <div className="stack-lg">
      <PageHead
        title={data.title}
        sub={`${data.scope === 'castle' ? `Малый совет замка «${data.department}»` : 'Королевский совет'} · созвал(а) ${data.organizer} · ${data.scheduledAt ? `назначено на ${dateTime(data.scheduledAt)}` : 'время не назначено'}`}
      >
        {data.ideaNumber ? (
          <a className="btn" href={`#/council/${data.ideaNumber}`}>
            Совет по обращению №{data.ideaNumber}
          </a>
        ) : null}
        {s.isLead || s.isAdmin || s.isArchivist ? (
          <a className="btn" href={`#/library/new?meeting=${data.id}${data.ideaNumber ? `&idea=${data.ideaNumber}` : ''}`}>
            Внести итог в Летопись
          </a>
        ) : null}
      </PageHead>

      {data.cancelledAt ? (
        <p className="notice error" role="status">
          Заседание отменено {dateTime(data.cancelledAt)}
          {data.cancelReason ? `: ${data.cancelReason}` : ''}. Запись и ответы больше не принимаются.
        </p>
      ) : null}
      {data.can.manage ? <ManagePanel view={data} onDone={reload} /> : null}
      <div className="meeting-grid">
        <div className="stack">
          <ConsentPanel view={data} onDone={reload} />
          <section className="panel stack" aria-labelledby="rec-h">
            <h2 id="rec-h" className="section-title">
              Запись
            </h2>
            {data.recording?.purgedAt ? (
              <p className="notice">Запись удалена {dateTime(data.recording.purgedAt)}: истёк срок хранения или её удалил администратор. Решения и подтверждённые находки сохранены.</p>
            ) : data.recording ? (
              <>
                <AudioPlayer meetingId={data.id} audioRef={player} />
                <p className="small muted">
                  {data.recording.source === 'microphone' ? 'Записано в приложении' : 'Загружен файл'} · {(data.recording.sizeBytes / 1024 / 1024).toFixed(1)} МБ
                  {data.recording.durationMs ? ` · ${fmt(data.recording.durationMs)}` : ''} · сохранил(а) {data.recording.uploadedBy}, {dateTime(data.recording.createdAt)} ·
                  SHA-256 {data.recording.sha256.slice(0, 10)}…
                </p>
              </>
            ) : data.can.record ? (
              <Recorder meetingId={data.id} onSaved={reload} />
            ) : organizer ? (
              <div className="stack">
                <p className="notice warn">
                  Запись станет доступна, когда согласие дадут все: ждём {waiting.map((p) => `${p.name} (${CONSENT[p.consent].label})`).join(', ')}. Согласие каждый
                  даёт только сам.
                </p>
                <p className="small">Можно провести заседание без записи: ведите письменный протокол в разделе «Расшифровка» ниже — согласие на запись для этого не нужно.</p>
              </div>
            ) : (
              <p className="small muted">Запись ведёт организатор. {waiting.length ? `Согласие ещё не дали: ${waiting.map((p) => p.name).join(', ')}.` : 'Все участники дали согласие.'}</p>
            )}
          </section>
          <TranscriptPanel view={data} onDone={reload} onSeek={seek} />
        </div>
        <FindingsPanel view={data} transcript={transcript} onDone={reload} onSeek={seek} />
      </div>
    </div>
  );
}

function ConsentPanel({ view, onDone }: { view: MeetingView; onDone: () => Promise<void> }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const me = view.participants.find((p) => p.membershipId === s.membershipId);
  async function attend(attendance: 'confirmed' | 'declined') {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/meetings/${view.id}/attendance`, { json: { attendance } });
      s.toast(attendance === 'confirmed' ? 'Участие подтверждено' : 'Организатор увидит, что вы не сможете присутствовать');
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  async function answer(consent: 'given' | 'declined') {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/meetings/${view.id}/consent`, { json: { consent } });
      s.toast(consent === 'given' ? 'Согласие на запись дано' : 'Вы отказались от записи: без вашего согласия запись не начнётся');
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel stack" aria-labelledby="cons-h">
      <h2 id="cons-h" className="section-title">
        Участники и согласие на запись
      </h2>
      <ul className="consent-list">
        {view.participants.map((p) => (
          <li key={p.membershipId}>
            <span>
              <b>{p.name}</b>
              <span className="small muted">{p.jobTitle ? `, ${p.jobTitle}` : ''}</span>
            </span>
            <span className="row">
              <span className="small muted">{p.attendance === 'confirmed' ? 'придёт' : p.attendance === 'declined' ? 'не сможет' : 'ответа нет'}</span>
              <span className={`seat-pill tone-${CONSENT[p.consent].tone}`}>{CONSENT[p.consent].label}</span>
            </span>
          </li>
        ))}
      </ul>
      {view.can.attend && me ? (
        <div className="row">
          <span className="small">Участие:</span>
          <button className="btn small" aria-pressed={me.attendance === 'confirmed'} disabled={busy || me.attendance === 'confirmed'} onClick={() => void attend('confirmed')}>
            Подтвердить участие
          </button>
          <button className="btn small" aria-pressed={me.attendance === 'declined'} disabled={busy || me.attendance === 'declined'} onClick={() => void attend('declined')}>
            Не могу присутствовать
          </button>
        </div>
      ) : null}
      {view.can.consent && view.myConsent !== null ? (
        <div className="consent-me stack">
          <p className="small">
            {view.myConsent === 'given'
              ? 'Вы дали согласие. Пока запись не началась, его можно отозвать.'
              : view.myConsent === 'declined'
                ? 'Вы отказались. Запись не начнётся, пока вы не согласитесь.'
                : 'Вас просят согласиться на запись заседания. Запись увидят только участники.'}
          </p>
          <div className="row">
            {view.myConsent !== 'given' ? (
              <button className="btn primary" disabled={busy} onClick={() => void answer('given')}>
                Согласен(на) на запись
              </button>
            ) : null}
            {view.myConsent !== 'declined' ? (
              <button className="btn" disabled={busy} onClick={() => void answer('declined')}>
                {view.myConsent === 'given' ? 'Отозвать согласие' : 'Не согласен(на)'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {view.recordingStartedAt ? <p className="small muted">Запись начата {dateTime(view.recordingStartedAt)}; состав и согласия зафиксированы.</p> : null}
      {err ? <p className="notice error">{err}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Recorder: microphone or an existing file
// ---------------------------------------------------------------------------
const MAX_BYTES = 25 * 1024 * 1024;
const EXT_TYPE: Record<string, string> = { webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav' };
function pickMime(): string {
  const R = (window as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) if (R?.isTypeSupported?.(t)) return t;
  return '';
}

function Recorder({ meetingId, onSaved }: { meetingId: string; onSaved: () => Promise<void> }) {
  const s = useSession();
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'saving'>('idle');
  const [ms, setMs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const live = state === 'recording' || state === 'paused';

  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setMs((x) => x + 250), 250);
    return () => clearInterval(t);
  }, [state]);
  useEffect(() => {
    // Leaving the page while recording or with an unsaved recording asks first.
    if (!live && state !== 'stopped') return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    const prev = document.title;
    if (live) document.title = `● Запись — ${prev}`;
    return () => {
      window.removeEventListener('beforeunload', h);
      document.title = prev;
    };
  }, [live, state]);
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview) : undefined), [preview]);

  async function start() {
    setErr(null);
    if (!navigator.mediaDevices?.getUserMedia || !(window as unknown as { MediaRecorder?: unknown }).MediaRecorder) {
      setErr('Этот браузер не умеет записывать звук. Загрузите готовый файл записи.');
      return;
    }
    setState('starting');
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as { name?: string }).name;
      setErr(
        name === 'NotAllowedError'
          ? 'Нет доступа к микрофону: разрешите его в настройках браузера для этого сайта и попробуйте снова.'
          : name === 'NotFoundError'
            ? 'Микрофон не найден. Подключите микрофон или загрузите готовый файл.'
            : 'Не удалось включить микрофон. Загрузите готовый файл записи.',
      );
      setState('idle');
      return;
    }
    try {
      await api(`/orgs/${s.org}/meetings/${meetingId}/recording/start`, { json: {} });
    } catch (x) {
      media.getTracks().forEach((t) => t.stop());
      setErr(errorText(x));
      setState('idle');
      return;
    }
    stream.current = media;
    const mime = pickMime();
    const r = new MediaRecorder(media, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32000 });
    chunks.current = [];
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    r.onstop = () => {
      const b = new Blob(chunks.current, { type: (r.mimeType || mime || 'audio/webm').split(';')[0] });
      media.getTracks().forEach((t) => t.stop());
      setBlob(b);
      setPreview(URL.createObjectURL(b));
      setState('stopped');
    };
    rec.current = r;
    r.start(1000);
    setMs(0);
    setState('recording');
  }
  const pause = () => {
    rec.current?.pause();
    setState('paused');
  };
  const resume = () => {
    rec.current?.resume();
    setState('recording');
  };
  const stop = () => rec.current?.stop();

  async function save(b: Blob, source: 'microphone' | 'upload', durationMs: number | null) {
    if (b.size > MAX_BYTES) {
      setErr('Файл больше 25 МБ. Сократите запись или сожмите её.');
      return;
    }
    setState('saving');
    setErr(null);
    try {
      await api(`/orgs/${s.org}/meetings/${meetingId}/recording`, {
        body: await b.arrayBuffer(),
        headers: { 'content-type': b.type || 'application/octet-stream', 'x-recording-source': source, ...(durationMs ? { 'x-duration-ms': String(Math.round(durationMs)) } : {}) },
      });
      s.toast('Запись сохранена');
      setBlob(null);
      await onSaved();
    } catch (x) {
      // The recording stays in the page: retry without losing it.
      setErr(`Запись не сохранена: ${errorText(x)} Нажмите «Сохранить запись» ещё раз.`);
      setState(source === 'microphone' ? 'stopped' : 'idle');
    }
  }
  async function upload(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const type = file.type && file.type.startsWith('audio/') ? file.type : EXT_TYPE[ext];
    if (!type) {
      setErr('Поддерживаются файлы WebM, OGG/Opus, MP3, M4A и WAV.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setErr('Файл больше 25 МБ.');
      return;
    }
    await save(new Blob([await file.arrayBuffer()], { type }), 'upload', null);
  }

  return (
    <div className="stack">
      {live ? (
        <div className={`rec-indicator${state === 'paused' ? ' is-paused' : ''}`} role="status" aria-live="polite">
          <span className="rec-dot" aria-hidden="true" />
          {state === 'paused' ? 'Запись на паузе' : 'Идёт запись'} · {fmt(ms)}
        </div>
      ) : null}
      <div className="row">
        {state === 'idle' || state === 'starting' ? (
          <button className="btn primary" disabled={state === 'starting'} onClick={() => void start()}>
            {state === 'starting' ? 'Включаем микрофон…' : 'Начать запись'}
          </button>
        ) : null}
        {state === 'recording' ? (
          <button className="btn" onClick={pause}>
            Пауза
          </button>
        ) : null}
        {state === 'paused' ? (
          <button className="btn" onClick={resume}>
            Продолжить
          </button>
        ) : null}
        {live ? (
          <button className="btn danger" onClick={stop}>
            Завершить запись
          </button>
        ) : null}
      </div>
      {state === 'stopped' && blob ? (
        <div className="stack">
          {preview ? <audio controls src={preview} className="audio" /> : null}
          <div className="row">
            <button className="btn primary" onClick={() => void save(blob, 'microphone', ms)}>
              Сохранить запись
            </button>
            <span className="small muted">{(blob.size / 1024).toFixed(0)} КБ · {fmt(ms)}</span>
          </div>
        </div>
      ) : null}
      {state === 'saving' ? <p className="small">Сохраняем запись…</p> : null}
      {state === 'idle' ? (
        <div className="stack">
          <span className="small muted">или загрузите готовый файл (WebM, OGG, MP3, M4A, WAV; до 25 МБ)</span>
          <input
            ref={fileRef}
            type="file"
            aria-label="Файл записи заседания"
            accept="audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav,.webm,.ogg,.opus,.mp3,.m4a,.wav"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </div>
      ) : null}
      {err ? (
        <p className="notice error" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

function AudioPlayer({ meetingId, audioRef }: { meetingId: string; audioRef: React.MutableRefObject<HTMLAudioElement | null> }) {
  const s = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    // The recording is fetched with the session token (no public URL), then played from memory.
    fetch(`/api/v1/orgs/${s.org}/meetings/${meetingId}/recording`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        const b = await r.blob();
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setErr('Не удалось загрузить запись. Проверьте связь и обновите страницу.'));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [s.org, meetingId]);
  useEffect(() => {
    const t = Number(hashParams().get('t'));
    const a = audioRef.current;
    if (!url || !a || !Number.isFinite(t) || t <= 0) return;
    const go = () => {
      a.currentTime = t / 1000;
    };
    a.addEventListener('loadedmetadata', go, { once: true });
    return () => a.removeEventListener('loadedmetadata', go);
  }, [url, audioRef]);
  if (err) return <p className="notice error">{err}</p>;
  if (!url) return <p className="small muted">Загружаем запись…</p>;
  return (
    <audio
      ref={audioRef}
      controls
      src={url}
      className="audio"
      onLoadedMetadata={(e) => {
        // Browser recordings (WebM) often lack a duration until scanned; this makes seeking work.
        const a = e.currentTarget;
        if (a.duration === Infinity) {
          a.currentTime = 1e9;
          a.addEventListener('timeupdate', () => (a.currentTime = 0), { once: true });
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------
function TranscriptPanel({ view, onDone, onSeek }: { view: MeetingView; onDone: () => Promise<void>; onSeek: (ms: number) => void }) {
  const s = useSession();
  const t = view.transcripts.at(-1) ?? null;
  const [text, setText] = useState('');
  const [source, setSource] = useState<'manual' | 'prepared' | 'minutes'>(view.recording ? 'manual' : 'minutes');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!t);
  async function run(what: string, fn: () => Promise<unknown>, done: string) {
    setBusy(what);
    setErr(null);
    try {
      await fn();
      s.toast(done);
      setText('');
      setOpen(false);
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(null);
    }
  }
  const lines = useMemo(() => (t ? t.text.split('\n') : []), [t]);
  return (
    <section className="panel stack" aria-labelledby="tr-h">
      <h2 id="tr-h" className="section-title">
        {view.recording ? 'Расшифровка' : 'Расшифровка или письменный протокол'}
      </h2>
      {t ? (
        <>
          <p className={`source-label src-${t.source}`}>{SOURCE_LABEL[t.source](t.engine)}</p>
          <ol className="transcript">
            {lines.map((line, i) => {
              const m = /^\[(\d{1,2}):(\d{2})\]\s*(.*)$/.exec(line);
              const at = m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
              return (
                <li key={i}>
                  {at !== null && view.recording && !view.recording.purgedAt ? (
                    <button type="button" className="ts" onClick={() => onSeek(at)} aria-label={`Прослушать с ${m![1]}:${m![2]}`}>
                      ▶ {m![1]}:{m![2]}
                    </button>
                  ) : at !== null ? (
                    <span className="ts">{`${m![1]}:${m![2]}`}</span>
                  ) : null}
                  <span>{m ? m[3] : line}</span>
                </li>
              );
            })}
          </ol>
          <p className="small muted">
            Добавил(а) {t.createdBy}, {dateTime(t.createdAt)} · SHA-256 {t.sha256.slice(0, 10)}…
          </p>
        </>
      ) : (
        <p className="small muted">Расшифровки пока нет.</p>
      )}
      {view.can.addTranscript ? (
        <>
          {view.recording ? (
            view.engine.configured ? (
              <button className="btn" disabled={!!busy} onClick={() => void run('engine', () => api(`/orgs/${s.org}/meetings/${view.id}/transcribe`, { json: {} }), 'Запись расшифрована')}>
                {busy === 'engine' ? 'Расшифровываем…' : `Расшифровать запись (${view.engine.model})`}
              </button>
            ) : (
              <p className="small muted">Движок расшифровки речи не подключён — расшифровку вставляют вручную. Можно подключить бесплатный локальный движок (см. документацию).</p>
            )
          ) : null}
          {t && !open ? (
            <button className="btn quiet small" onClick={() => setOpen(true)}>
              Добавить другую расшифровку
            </button>
          ) : null}
          {open ? (
            <div className="stack">
              <div className="field">
                <div className="spread">
                  <label htmlFor="tr-text">{source === 'minutes' ? 'Протокол: строки вида «Имя Фамилия: что сказано», пункты под «Решили:»' : 'Текст расшифровки: строки вида «[мм:сс] Имя Фамилия: реплика»'}</label>
                  <button
                    type="button"
                    className="btn quiet small"
                    onClick={() => {
                      setText(DEMO_TRANSCRIPT);
                      setSource('prepared');
                    }}
                  >
                    Подставить подготовленную (демо)
                  </button>
                </div>
                <textarea id="tr-text" className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={100000} />
              </div>
              <fieldset className="field">
                <legend>Откуда текст</legend>
                <label className="check">
                  <input type="radio" name="tr-src" checked={source === 'minutes'} onChange={() => setSource('minutes')} /> Письменный протокол заседания без записи
                </label>
                <label className="check">
                  <input type="radio" name="tr-src" checked={source === 'manual'} onChange={() => setSource('manual')} /> Расшифровка, набранная вручную по записи
                </label>
                <label className="check">
                  <input type="radio" name="tr-src" checked={source === 'prepared'} onChange={() => setSource('prepared')} /> Подготовленная расшифровка (демо) — будет так и помечена
                </label>
              </fieldset>
              <div>
                <button
                  className="btn primary"
                  disabled={!!busy || text.trim().length < 20}
                  onClick={() => void run('add', () => api(`/orgs/${s.org}/meetings/${view.id}/transcripts`, { json: { text, source } }), 'Расшифровка сохранена')}
                >
                  {busy === 'add' ? 'Сохраняем…' : 'Сохранить расшифровку'}
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {err ? <p className="notice error">{err}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
function FindingsPanel({
  view,
  transcript,
  onDone,
  onSeek,
}: {
  view: MeetingView;
  transcript: MeetingView['transcripts'][number] | null;
  onDone: () => Promise<void>;
  onSeek: (ms: number) => void;
}) {
  const s = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const analyses = transcript ? view.analyses.filter((a) => a.transcriptId === transcript.id) : [];
  const shownIds = new Set(analyses.map((a) => a.id));
  const findings = view.findings.filter((f) => shownIds.has(f.analysisId));
  async function analyze(method: 'rules' | 'model') {
    if (!transcript) return;
    setBusy(method);
    setErr(null);
    try {
      const r = await api<{ findings: number | null; dropped: number; replayed: boolean }>(`/orgs/${s.org}/meetings/${view.id}/analyses`, { json: { transcriptId: transcript.id, method } });
      s.toast(r.replayed ? 'Эта расшифровка уже разобрана этим способом — показаны сохранённые находки' : `Находок: ${r.findings}${r.dropped ? `; отброшено без точной цитаты: ${r.dropped}` : ''}`);
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(null);
    }
  }
  const left = findings.filter((f) => f.status === 'proposed').length;
  return (
    <section className="stack" aria-labelledby="fd-h">
      <div className="panel stack">
        <h2 id="fd-h" className="section-title">
          Находки заседания
        </h2>
        <p className="small muted">
          Сохраняются как черновики в памяти компании. Обращение или поручение появляется только после подтверждения руководителем — участником
          заседания.
        </p>
        {transcript && view.can.review ? (
          <div className="row">
            <button className="btn primary" disabled={!!busy || analyses.some((a) => a.method === 'rules')} onClick={() => void analyze('rules')}>
              {busy === 'rules' ? 'Ищем…' : 'Найти по шаблону (без ИИ)'}
            </button>
            <button
              className="btn"
              disabled={!!busy || !view.model.configured || analyses.some((a) => a.method === 'model')}
              onClick={() => void analyze('model')}
              title={view.model.configured ? '' : 'Языковая модель не подключена'}
            >
              {busy === 'model' ? 'Модель думает…' : view.model.configured ? `Локальной моделью ${view.model.model}` : 'Модель не подключена'}
            </button>
          </div>
        ) : !transcript ? (
          <p className="small">Сначала нужна расшифровка.</p>
        ) : null}
        {analyses.length ? (
          <p className="small">
            {analyses.map((a) => (a.method === 'rules' ? 'По шаблону (без ИИ)' : `Модель ${a.model}`)).join(' и ')} · находок {findings.length}, ждут проверки {left}
          </p>
        ) : null}
        {err ? <p className="notice error">{err}</p> : null}
      </div>
      {findings.map((f) => (
        <FindingCard key={f.id} view={view} f={f} onDone={onDone} onSeek={onSeek} />
      ))}
    </section>
  );
}

function FindingCard({ view, f, onDone, onSeek }: { view: MeetingView; f: MeetingFinding; onDone: () => Promise<void>; onSeek: (ms: number) => void }) {
  const s = useSession();
  const dir = s.directory;
  const canItem = ITEM_TYPES.includes(f.type);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(f.kind);
  const [title, setTitle] = useState(f.title);
  const [problem, setProblem] = useState(f.kind === 'problem' ? f.quote : '');
  const [proposal, setProposal] = useState(f.kind === 'idea' ? f.quote : '');
  const [raisedBy, setRaisedBy] = useState(f.speakerMembershipId && f.speakerMembershipId !== s.membershipId ? f.speakerMembershipId : '');
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState(view.departmentId ?? '');
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const members = (dir?.members ?? []).filter((m) => m.access === 'member' && m.membershipId !== s.membershipId);
  const short = title.trim().length < 3 || problem.trim().length < 20 || (kind === 'idea' && proposal.trim().length < 20);

  async function act(path: string, body: unknown, done: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ item?: { number: number } }>(`/orgs/${s.org}/meetings/${view.id}/findings/${f.id}/${path}`, { key, json: body });
      s.toast(r.item ? `${done}: обращение №${r.item.number}` : done);
      await onDone();
      void s.refreshInbox();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  const fid = (n: string) => `f${f.id.slice(0, 8)}-${n}`;
  return (
    <article className="panel stack finding" data-status={f.status} aria-labelledby={fid('h')}>
      <div className="spread">
        <h3 id={fid('h')} className="finding-h">
          <span className={`finding-type t-${f.type}`}>{FINDING_LABEL[f.type]}</span> {f.title}
        </h3>
        {f.startMs !== null && view.recording && !view.recording.purgedAt ? (
          <button type="button" className="ts" onClick={() => onSeek(f.startMs!)} aria-label={`Прослушать фрагмент с ${fmt(f.startMs)}`}>
            ▶ {fmt(f.startMs)}
          </button>
        ) : f.startMs !== null ? (
          <span className="ts">{fmt(f.startMs)}</span>
        ) : null}
      </div>
      <blockquote className="quote-block">
        {f.quote}
        <footer className="small muted">
          {f.speakerLabel ? (f.speakerMembershipId ? `Говорит: ${f.speakerLabel}` : `В расшифровке: «${f.speakerLabel}» — не сопоставлен с участником`) : 'Говорящий не указан'} ·{' '}
          {f.confidence ? CONF[f.confidence] : 'уверенность не оценена'}
          {f.basis ? ` · ${f.basis}` : ''}
        </footer>
      </blockquote>
      {f.status === 'accepted' ? (
        <p className="small">
          Подтвердил(а) {f.decidedBy}: <a href={`#/items/${f.itemNumber}`}>обращение №{f.itemNumber}</a>
        </p>
      ) : f.status === 'noted' ? (
        <p className="small muted">Сохранено в памяти компании — {f.decidedBy}</p>
      ) : f.status === 'dismissed' ? (
        <p className="small muted">Отклонено — {f.decidedBy}</p>
      ) : !view.can.review ? (
        <p className="small muted">Ждёт проверки руководителем.</p>
      ) : !open ? (
        <div className="row">
          {canItem ? (
            <button className="btn primary small" onClick={() => setOpen(true)}>
              Проверить и создать обращение
            </button>
          ) : null}
          <button className="btn small" disabled={busy} onClick={() => void act('note', {}, 'Сохранено в памяти компании')}>
            В память без обращения
          </button>
          <button className="btn quiet small" disabled={busy} onClick={() => void act('dismiss', {}, 'Находка отклонена')}>
            Отклонить
          </button>
        </div>
      ) : (
        <div className="stack">
          <div className="segmented" role="radiogroup" aria-label="Что это">
            {(['problem', 'idea'] as const).map((x) => (
              <button key={x} type="button" role="radio" aria-checked={kind === x} aria-pressed={kind === x} onClick={() => setKind(x)}>
                {x === 'problem' ? 'Проблема' : 'Предложение / поручение'}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor={fid('t')}>Название</label>
            <input id={fid('t')} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
          </div>
          <div className="field">
            <label htmlFor={fid('p')}>Что сейчас не так</label>
            <textarea id={fid('p')} className="textarea" rows={2} value={problem} onChange={(e) => setProblem(e.target.value)} maxLength={5000} placeholder="В записи не сказано — опишите со слов участников" />
          </div>
          {kind === 'idea' ? (
            <div className="field">
              <label htmlFor={fid('o')}>Что предлагают или поручили</label>
              <textarea id={fid('o')} className="textarea" rows={2} value={proposal} onChange={(e) => setProposal(e.target.value)} maxLength={5000} />
            </div>
          ) : null}
          <div className="grid-2">
            <div className="field">
              <label htmlFor={fid('w')}>Кто поднял</label>
              <select id={fid('w')} className="select" value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)}>
                <option value="">Я сам / не указано</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={fid('c')}>Тема</label>
              <select id={fid('c')} className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
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
            <label htmlFor={fid('d')}>Подразделение</label>
            <select id={fid('d')} className="select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
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
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || short}
              onClick={() =>
                void act(
                  'accept',
                  {
                    kind,
                    title: title.trim(),
                    problem: problem.trim(),
                    ...(kind === 'idea' ? { proposal: proposal.trim() } : {}),
                    ...(categoryId ? { categoryId } : {}),
                    ...(departmentId ? { departmentId } : {}),
                    ...(raisedBy ? { raisedBy } : {}),
                  },
                  'Находка подтверждена',
                )
              }
            >
              {busy ? 'Сохраняем…' : 'Подтвердить и зарегистрировать'}
            </button>
            <button className="btn quiet" disabled={busy} onClick={() => setOpen(false)}>
              Отмена
            </button>
          </div>
          {short ? <span className="hint">Описание — от 20 символов{kind === 'idea' ? ', предложение тоже' : ''}.</span> : null}
        </div>
      )}
      {err ? <p className="notice error">{err}</p> : null}
    </article>
  );
}

/** Organizer: time, cancellation and the participant list — until recording starts. */
function ManagePanel({ view, onDone }: { view: MeetingView; onDone: () => Promise<void> }) {
  const s = useSession();
  const [when, setWhen] = useState('');
  const [reason, setReason] = useState('');
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inside = new Set(view.participants.map((p) => p.membershipId));
  const candidates = (s.directory?.members ?? []).filter((m) => m.access === 'member' && !inside.has(m.membershipId));
  async function run(path: string, json: unknown, done: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/meetings/${view.id}/${path}`, { json });
      s.toast(done);
      await onDone();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="panel manage">
      <summary className="section-title">Управление заседанием (организатор)</summary>
      <div className="stack">
        <div className="row">
          <label htmlFor="mg-when" className="small">
            Перенести на
          </label>
          <input id="mg-when" className="input compact" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <button className="btn small" disabled={busy || !when} onClick={() => void run('reschedule', { scheduledAt: new Date(when).toISOString() }, 'Время изменено: участники получили сообщение')}>
            Перенести
          </button>
        </div>
        <div className="row">
          <label htmlFor="mg-add" className="small">
            Добавить участника
          </label>
          <select id="mg-add" className="select compact" value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">—</option>
            {candidates.map((m) => (
              <option key={m.membershipId} value={m.membershipId}>
                {m.name}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={busy || !add} onClick={() => void run('participants', { membershipId: add, present: true }, 'Участник добавлен и приглашён')}>
            Добавить
          </button>
        </div>
        <ul className="consent-list">
          {view.participants
            .filter((p) => p.membershipId !== view.organizerMembershipId)
            .map((p) => (
              <li key={p.membershipId}>
                <span>{p.name}</span>
                <button className="btn quiet small" disabled={busy} onClick={() => void run('participants', { membershipId: p.membershipId, present: false }, `${p.name}: убран(а) из участников, доступ закрыт`)}>
                  Убрать
                </button>
              </li>
            ))}
        </ul>
        <div className="row">
          <input className="input compact" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Причина отмены" aria-label="Причина отмены" maxLength={500} />
          <button className="btn small danger" disabled={busy || reason.trim().length < 3} onClick={() => void run('cancel', { reason: reason.trim() }, 'Заседание отменено: участники получили сообщение')}>
            Отменить заседание
          </button>
        </div>
        {err ? <p className="notice error">{err}</p> : null}
      </div>
    </details>
  );
}
