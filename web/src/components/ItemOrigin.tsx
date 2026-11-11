import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { ItemOrigin as Origin } from '../lib/types';

/**
 * Organizational memory on the item card (ADR-0014): where the question came
 * from — the meeting, the exact words, the moment in the recording and who
 * confirmed it. Shown only to participants of that meeting (the API returns
 * nothing to others).
 */
const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function ItemOrigin({ number }: { number: number }) {
  const s = useSession();
  const { data } = useLoad(() => api<Origin | null>(`/orgs/${s.org}/ideas/${number}/origin`).catch(() => null), [s.org, number]);
  if (!data) return null;
  return (
    <section className="panel stack origin" aria-label="Откуда взялось обращение">
      <p className="small">
        <b>Возникло на заседании</b> <a href={`#/meetings/${data.meetingId}${data.startMs !== null ? `?t=${data.startMs}` : ''}`}>«{data.title}»</a>
        {data.startMs !== null ? <> · {data.recordingAvailable ? '▶ ' : ''}{fmt(data.startMs)}{data.recordingAvailable === false ? ' (запись удалена по сроку хранения)' : ''}</> : null}
        {data.speaker ? ` · говорит ${data.speaker}` : ''}
      </p>
      <blockquote className="quote-block">{data.quote}</blockquote>
      <p className="small muted">
        {data.transcriptSource === 'prepared' ? 'По подготовленной расшифровке (демо). ' : data.transcriptSource === 'manual' ? 'По расшифровке, введённой вручную. ' : data.transcriptSource === 'minutes' ? 'По письменному протоколу (без записи). ' : 'По расшифровке локального движка. '}
        {data.confirmedBy ? `Подтвердил(а) ${data.confirmedBy}${data.confirmedAt ? `, ${dateTime(data.confirmedAt)}` : ''}.` : ''}
      </p>
    </section>
  );
}
