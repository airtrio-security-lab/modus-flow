import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

/**
 * Retention of meeting material (ADR-0015) — admins only. Shows what is stored and until
 * when (never the content), sets the retention periods, the legal hold and deletes with a
 * reason. Every action lands in an append-only log shown below.
 */
interface Overview {
  settings: { audioDays: number; transcriptDays: number };
  meetings: {
    meetingId: string;
    title: string;
    createdAt: string;
    legalHold: boolean;
    legalHoldReason: string | null;
    recordingAt: string | null;
    recordingBytes: number | null;
    recordingPurgedAt: string | null;
    recordingExpiresAt: string | null;
    transcripts: number;
    transcriptsPurged: number;
    transcriptExpiresAt: string | null;
  }[];
  log: { at: string; object: string; action: string; reason: string; sha256: string | null; actor: string; meeting: string | null }[];
  note: string;
}
const ACTION: Record<string, string> = { purged: 'Удалено', hold_set: 'Удержание установлено', hold_released: 'Удержание снято', retention_changed: 'Сроки изменены' };
const OBJECT: Record<string, string> = { recording: 'запись', transcript: 'расшифровка', meeting: 'заседание', organization: 'организация' };

export function RetentionSettings() {
  const s = useSession();
  const { data, error, reload } = useLoad(() => api<Overview>(`/orgs/${s.org}/retention`), [s.org]);
  const [audio, setAudio] = useState('');
  const [tr, setTr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (data) {
      setAudio(String(data.settings.audioDays));
      setTr(String(data.settings.transcriptDays));
    }
  }, [data]);
  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      s.toast(done);
      await reload();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(null);
    }
  }
  const ask = (q: string) => {
    const r = window.prompt(q);
    return r && r.trim().length >= 5 ? r.trim() : null;
  };
  if (error) return <p className="notice error">{errorText(error)}</p>;
  if (!data) return null;
  const a = Number(audio);
  const t = Number(tr);
  const bad = !Number.isInteger(a) || !Number.isInteger(t) || a < 1 || t < 1 || a > 3650 || t > 3650;
  return (
    <section className="panel stack" aria-labelledby="ret-h">
      <h2 id="ret-h" className="section-title">
        Хранение записей заседаний
      </h2>
      <p className="small muted">{data.note}</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="ret-a">Аудиозаписи, дней</label>
          <input id="ret-a" className="input" inputMode="numeric" value={audio} onChange={(e) => setAudio(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ret-t">Расшифровки, дней</label>
          <input id="ret-t" className="input" inputMode="numeric" value={tr} onChange={(e) => setTr(e.target.value)} />
        </div>
      </div>
      <div>
        <button
          className="btn"
          disabled={!!busy || bad || (a === data.settings.audioDays && t === data.settings.transcriptDays)}
          onClick={() => void run('days', () => api(`/orgs/${s.org}/retention`, { method: 'PUT', json: { audioDays: a, transcriptDays: t } }), 'Сроки хранения изменены')}
        >
          Сохранить сроки
        </button>
      </div>
      <p className="small muted">
        Удалённое по сроку стирается ежедневной задачей. После восстановления базы из резервной копии та же задача стирает снова всё, что было удалено ранее
        (по журналу). Резервные копии храните не дольше срока хранения аудио.
      </p>
      {data.meetings.length ? (
        <ul className="retention-list">
          {data.meetings.map((m) => (
            <li key={m.meetingId}>
              <div>
                <b>{m.title}</b> <span className="small muted">{dateTime(m.createdAt)}</span>
                {m.legalHold ? <span className="flag red">законное удержание: {m.legalHoldReason}</span> : null}
              </div>
              <div className="small">
                Запись:{' '}
                {m.recordingPurgedAt
                  ? `удалена ${dateTime(m.recordingPurgedAt)}`
                  : m.recordingAt
                    ? `${((m.recordingBytes ?? 0) / 1024 / 1024).toFixed(1)} МБ, хранится до ${dateTime(m.recordingExpiresAt!)}`
                    : 'нет'}
                {' · '}Расшифровки: {m.transcripts ? `${m.transcripts - m.transcriptsPurged} из ${m.transcripts}${m.transcriptExpiresAt ? `, до ${dateTime(m.transcriptExpiresAt)}` : ''}` : 'нет'}
              </div>
              <div className="row">
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() => {
                    const why = ask(m.legalHold ? 'Почему снимаете удержание?' : 'Законное основание для сохранения (например, запрос суда):');
                    if (why) void run(m.meetingId, () => api(`/orgs/${s.org}/meetings/${m.meetingId}/legal-hold`, { json: { hold: !m.legalHold, reason: why } }), m.legalHold ? 'Удержание снято' : 'Удержание установлено');
                  }}
                >
                  {m.legalHold ? 'Снять удержание' : 'Законное удержание'}
                </button>
                {!m.legalHold && (m.recordingAt && !m.recordingPurgedAt || m.transcripts > m.transcriptsPurged) ? (
                  <button
                    className="btn small danger"
                    disabled={!!busy}
                    onClick={() => {
                      const why = ask('Причина удаления записи и расшифровок (попадёт в журнал):');
                      if (why) void run(m.meetingId, () => api(`/orgs/${s.org}/meetings/${m.meetingId}/purge`, { json: { what: 'all', reason: why } }), 'Удалено, факт записан в журнал');
                    }}
                  >
                    Удалить запись и расшифровки
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Заседаний с материалами нет.</p>
      )}
      {err ? <p className="notice error">{err}</p> : null}
      <h3 className="realm-sub-h">Журнал хранения (изменить или удалить нельзя)</h3>
      {data.log.length ? (
        <ol className="journal">
          {data.log.map((l, i) => (
            <li key={i}>
              <span className="small muted">{dateTime(l.at)}</span>
              <span>
                <b>{ACTION[l.action] ?? l.action}</b> — {OBJECT[l.object] ?? l.object}
                {l.meeting ? ` «${l.meeting}»` : ''}, {l.actor}
              </span>
              <span className="small">
                {l.reason}
                {l.sha256 ? ` · SHA-256 ${l.sha256.slice(0, 10)}…` : ''}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="small muted">Записей пока нет.</p>
      )}
    </section>
  );
}
