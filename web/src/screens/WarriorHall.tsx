import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';
import { go } from '../lib/router';
import { useSession } from '../lib/session';
import './warrior-hall.css';

/** Personal Lab stores private ideas; the ordinary item/Council system handles public discussion. */
interface LabContent { observation?: string; proposal?: string; notes?: string; }
interface LabDraft {
  id: string;
  kind: 'idea' | 'problem';
  state: 'private' | 'published';
  version: number;
  title: string;
  content: LabContent;
}
interface Published { idea: { number: number }; }
interface Discussion { number: number; title: string; entries: number; great: boolean; }
interface Form { title: string; observation: string; proposal: string; notes: string; }
const EMPTY: Form = { title: '', observation: '', proposal: '', notes: '' };
const fromDraft = (d: LabDraft): Form => ({
  title: d.title, observation: d.content.observation ?? '',
  proposal: d.content.proposal ?? '', notes: d.content.notes ?? '',
});
const toContent = (f: Form): LabContent => ({
  ...(f.observation.trim() ? { observation: f.observation.trim() } : {}),
  ...(f.proposal.trim() ? { proposal: f.proposal.trim() } : {}),
  ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
});

export function WarriorHall({ departmentId, departmentName, discussions }: {
  departmentId: string; departmentName: string; discussions: Discussion[];
}) {
  const s = useSession();
  const [drafts, setDrafts] = useState<LabDraft[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<LabDraft[]>('/lab/drafts').then((data) => {
      if (alive) {
        setDrafts(data.filter((d) => d.state === 'private' && d.kind === 'idea'));
        setLoading(false);
      }
    }).catch((e: unknown) => {
      if (alive) { setError(errorText(e)); setLoading(false); }
    });
    return () => { alive = false; };
  }, [s.org, s.membershipId]);

  const selected = drafts.find((d) => d.id === selectedId) ?? null;
  const savedForm = selected ? fromDraft(selected) : null;
  const changed = !savedForm || (Object.keys(EMPTY) as (keyof Form)[])
    .some((key) => form[key].trim() !== savedForm[key].trim());
  const ready = form.title.trim().length >= 3 &&
    form.observation.trim().length >= 20 && form.proposal.trim().length >= 20;
  const canPublish = !!selected && !changed && ready && !busy;

  function edit(key: keyof Form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
    setNotice(null);
  }
  function choose(draft: LabDraft | null) {
    const hasText = Object.values(form).some((v) => v.trim());
    if (changed && hasText && !window.confirm('Несохранённые изменения будут потеряны. Продолжить?')) return;
    setSelectedId(draft?.id ?? null);
    setForm(draft ? fromDraft(draft) : EMPTY);
    setNotice(null);
    setError(null);
  }

  async function save() {
    if (busy) return;
    if (form.title.trim().length < 3) {
      setError('Назовите мысль — не менее трёх символов.');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const title = form.title.trim();
      const content = toContent(form);
      const saved = selected
        ? await api<LabDraft>('/lab/drafts/' + selected.id + '/versions', {
            json: { baseVersion: selected.version, title, content },
          })
        : await api<LabDraft>('/lab/drafts', { json: { kind: 'idea', title, content } });
      setDrafts((list) => [saved, ...list.filter((d) => d.id !== saved.id)]);
      setSelectedId(saved.id);
      setForm(fromDraft(saved));
      setNotice('Сохранено в Личной лаборатории. Коллеги не видят эту запись.');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function publish() {
    if (!selected || !canPublish) return;
    setBusy('publish');
    setError(null);
    try {
      const result = await api<Published>('/lab/drafts/' + selected.id + '/publish', {
        json: { organization: s.org, departmentId },
        key: 'warrior-hall-publish-' + selected.id,
      });
      s.toast('Предложение №' + result.idea.number + ' отправлено. Авторство сохранено.');
      go('/items/' + result.idea.number);
    } catch (e) { setError(errorText(e)); setBusy(null); }
  }

  return (
    <div className="stack-lg warrior-hall">
      <section className="warrior-hall-intro" aria-label={'Зал воинов подразделения ' + departmentName}>
        <span className="warrior-hall-mark" aria-hidden="true">✦</span>
        <div>
          <h2>Зал воинов · {departmentName}</h2>
          <p>Место, где мысли превращаются в предложения. Запишите идею, сохраните и пригласите коллег к обсуждению.</p>
        </div>
        <a className="btn quiet small" href={'#/castles/' + departmentId + '/council'}>Зал Совета</a>
      </section>
      <p className="small muted">
        Личные записи доступны только вам. При отправке публикуются название, описание ситуации и предложение.
        Личные заметки остаются закрытыми. Дальнейшее обсуждение проходит в обычном обращении и Совете.
      </p>
      <div className="warrior-hall-columns">
        <section className="panel stack" aria-labelledby="warrior-notes-heading">
          <div className="row">
            <h3 id="warrior-notes-heading" className="section-title">Мои мысли</h3>
            <button type="button" className="btn small" disabled={!!busy} onClick={() => choose(null)}>Новая запись</button>
          </div>
          {loading ? <p className="muted small">Загружаем личные записи…</p> : null}
          {!loading && !drafts.length ? <p className="muted small">Сохранённых мыслей пока нет.</p> : null}
          {drafts.length ? (
            <ul className="warrior-note-list">
              {drafts.map((d) => (
                <li key={d.id}>
                  <button type="button" className={selectedId === d.id ? 'is-selected' : ''} disabled={!!busy} onClick={() => choose(d)}>
                    <b>{d.title}</b><span>Черновик · версия {d.version}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="small muted">Ваши личные черновики из Лаборатории. Отправка привяжет предложение к выбранному отделу.</p>
        </section>
        <section className="panel stack" aria-labelledby="warrior-editor-heading">
          <h3 id="warrior-editor-heading" className="section-title">{selected ? 'Редактирование мысли' : 'Новая мысль'}</h3>
          <label className="field">
            <span>Название</span>
            <input className="input" value={form.title} maxLength={160} onChange={(e) => edit('title', e.target.value)} placeholder="Что стоит улучшить?" />
          </label>
          <label className="field">
            <span>Заметки для себя (не отправляются)</span>
            <textarea className="textarea" value={form.notes} rows={4} maxLength={20000} onChange={(e) => edit('notes', e.target.value)} placeholder="Мысли, сомнения, альтернативы…" />
          </label>
          <label className="field">
            <span>Что сейчас происходит?</span>
            <textarea className="textarea" value={form.observation} rows={3} maxLength={5000} onChange={(e) => edit('observation', e.target.value)} placeholder="Для отправки — минимум 20 символов" />
          </label>
          <label className="field">
            <span>Что предлагаете сделать?</span>
            <textarea className="textarea" value={form.proposal} rows={3} maxLength={5000} onChange={(e) => edit('proposal', e.target.value)} placeholder="Для отправки — минимум 20 символов" />
          </label>
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          {notice ? <p className="notice" role="status">{notice}</p> : null}
          <div className="row">
            <button type="button" className="btn" disabled={!!busy || form.title.trim().length < 3} onClick={() => void save()}>
              {busy === 'save' ? 'Сохраняем…' : selected ? 'Сохранить новую версию' : 'Сохранить мысль'}
            </button>
            <button type="button" className="btn primary" disabled={!canPublish} onClick={() => void publish()}>
              {busy === 'publish' ? 'Отправляем…' : 'Отправить на обсуждение'}
            </button>
          </div>
          {!selected ? <p className="small muted">Сначала сохраните мысль. Публикация происходит только по вашему выбору.</p> : null}
          {selected && changed ? <p className="small muted">Сохраните изменения перед отправкой.</p> : null}
          {selected && !ready ? <p className="small muted">Для отправки нужны название, описание ситуации и предлагаемое решение. Вести частные заметки можно без этих полей.</p> : null}
        </section>
      </div>
      <section className="panel stack" aria-labelledby="warrior-discussions-heading">
        <h3 id="warrior-discussions-heading" className="section-title">Обсуждения подразделения</h3>
        <p className="muted small">Открывайте обращения, аргументы и рекомендации — в пределах ваших прав доступа.</p>
        {discussions.length ? (
          <ul className="district-list">
            {discussions.map((d) => (
              <li key={d.number}>
                <a href={'#/council/' + d.number}>№{d.number} · {d.title}</a>
                <span className="small muted">{d.great ? 'Большой совет' : 'Малый совет'} · {d.entries ? d.entries + ' записей' : 'ожидает обсуждения'}</span>
              </li>
            ))}
          </ul>
        ) : <p className="small muted">Обращений в Совете пока нет. Сохранённую мысль можно оформить и отправить на рассмотрение.</p>}
      </section>
    </div>
  );
}
