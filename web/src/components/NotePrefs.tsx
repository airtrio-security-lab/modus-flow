import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { NotePreferences } from '../lib/types';

/**
 * Settings of «Королевские послания» (ADR-0016): game or business wording, the form of
 * address (chosen by the person — never guessed from a name), grouping of repeats, and
 * optional messages. Messages about decisions, deadlines, assignments and meetings cannot
 * be switched off. Only the in-app channel exists in this version.
 */
const FORMS: { id: NotePreferences['addressForm']; label: string }[] = [
  { id: 'title', label: 'По моему званию' },
  { id: 'milord', label: 'Милорд' },
  { id: 'milady', label: 'Миледи' },
  { id: 'master', label: 'Мастер' },
  { id: 'neutral', label: 'Нейтрально: «Коллега»' },
];
const OPTIONAL: { events: string[]; label: string }[] = [
  { events: ['castle_xp', 'castle_level_up', 'contribution_confirmed', 'honor_board_recognition'], label: 'Опыт и уровни замка' },
  { events: ['comment_added', 'status_report', 'revision_submitted', 'suggestion_submitted', 'objection_raised'], label: 'Комментарии и ход работ по моим обращениям' },
  { events: ['council_recommendation', 'meeting_recording_started', 'meeting_findings_ready'], label: 'Рекомендации Совета, запись и находки заседаний' },
];

export function NotePrefs() {
  const s = useSession();
  const { data, reload } = useLoad(() => api<NotePreferences>(`/orgs/${s.org}/me/notification-preferences`), [s.org]);
  const [p, setP] = useState<NotePreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setP(data), [data]);
  if (!p) return null;
  const muted = new Set(p.muted);
  const preview = p.style === 'business' ? 'Без игровых обращений' : p.addressForm === 'title' ? p.address : FORMS.find((f) => f.id === p.addressForm)!.label.replace('Нейтрально: «Коллега»', 'Коллега');

  async function save() {
    if (!p) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/me/notification-preferences`, { method: 'PUT', json: { style: p.style, addressForm: p.addressForm, groupRepeats: p.groupRepeats, muted: p.muted } });
      s.toast('Настройки посланий сохранены');
      await reload();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel stack" aria-labelledby="np-h">
      <h2 id="np-h" className="section-title">
        Королевские послания
      </h2>
      <fieldset className="field">
        <legend>Стиль</legend>
        <label className="check">
          <input type="radio" name="np-style" checked={p.style === 'royal'} onChange={() => setP({ ...p, style: 'royal' })} /> Игровой: заголовки и обращения
          королевства, деловой текст ниже
        </label>
        <label className="check">
          <input type="radio" name="np-style" checked={p.style === 'business'} onChange={() => setP({ ...p, style: 'business' })} /> Деловой: только деловой
          текст
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor="np-form">Как ко мне обращаться</label>
        <select id="np-form" className="select" value={p.addressForm} disabled={p.style === 'business'} onChange={(e) => setP({ ...p, addressForm: e.target.value as NotePreferences['addressForm'] })}>
          {FORMS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.id === 'title' ? `${f.label}${p.title ? `: ${p.address}` : ''}` : f.label}
            </option>
          ))}
        </select>
        <span className="hint">Так к вам обратятся: {preview}. {p.note}</span>
      </div>
      <label className="check">
        <input type="checkbox" checked={p.groupRepeats} onChange={(e) => setP({ ...p, groupRepeats: e.target.checked })} /> Группировать повторы об одном и
        том же за сутки
      </label>
      <fieldset className="field">
        <legend>Что присылать</legend>
        {OPTIONAL.map((o) => (
          <label key={o.label} className="check">
            <input
              type="checkbox"
              checked={!o.events.every((e) => muted.has(e))}
              onChange={(e) => {
                const next = new Set(muted);
                for (const ev of o.events) e.target.checked ? next.delete(ev) : next.add(ev);
                setP({ ...p, muted: [...next] });
              }}
            />{' '}
            {o.label}
          </label>
        ))}
        <span className="hint">Решения, сроки, поручения, вызовы на Совет и просьбы уточнить приходят всегда — их отключить нельзя.</span>
      </fieldset>
      <fieldset className="field">
        <legend>Каналы</legend>
        {p.channels.map((c) => (
          <label key={c.id} className="check">
            <input type="checkbox" checked={c.available} disabled readOnly /> {c.label}
            {c.note ? <span className="muted"> — {c.note}</span> : null}
          </label>
        ))}
      </fieldset>
      {err ? <p className="notice error">{err}</p> : null}
      <div>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>
    </section>
  );
}
