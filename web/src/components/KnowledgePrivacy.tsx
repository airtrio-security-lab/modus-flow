import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { dateTime } from '../lib/format';
import { useLoad, useSession } from '../lib/session';

/**
 * Personal data in organizational memory (ADR-0018) — admins only. The scan names places and
 * kinds, never the text (an admin may erase what they are not allowed to read). Erasure and
 * pseudonymization need a legal basis and a request reference; the log below keeps the fact.
 */
type Loc = { t: 'version'; v: number; f: string } | { t: 'transition' | 'source' | 'application'; id: string };
interface Scan {
  scanned: number;
  findings: { id: string; title: string; hall: string; readable: boolean; places: { loc: Loc; place: string; kinds: string[] }[] }[];
  log: { id: string; scope: string; basis: string; ref: string; places: number; rowsChanged: number; actor: string | null; at: string }[];
  bases: { id: string; title: string }[];
  note: string;
}
const key = (k: string, l: Loc) => `${k}|${JSON.stringify(l)}`;

export function KnowledgePrivacy() {
  const s = useSession();
  const { data, error, reload } = useLoad(() => api<Scan>(`/orgs/${s.org}/privacy/knowledge`), [s.org]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [basis, setBasis] = useState('subject_request');
  const [ref, setRef] = useState('');
  const [member, setMember] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const members = (s.directory?.members ?? []).filter((m) => m.access === 'member');

  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      s.toast(done);
      setPicked(new Set());
      setRef('');
      await reload();
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(false);
    }
  }
  async function eraseSelected() {
    for (const f of data?.findings ?? []) {
      const places = f.places.filter((p) => picked.has(key(f.id, p.loc))).map((p) => p.loc);
      if (places.length) await api(`/orgs/${s.org}/knowledge/${f.id}/erasure`, { method: 'POST', json: { basis, ref, places } });
    }
  }

  return (
    <section className="panel stack" aria-labelledby="kpriv-h">
      <h2 className="section-title" id="kpriv-h">Персональные данные в знаниях</h2>
      <p className="small muted">
        Проверка всех версий карточек, причин переходов и примечаний Великой библиотеки. Показываются места и вид сведений — сам текст не показывается.
        Удаление заменяет текст пометкой во всех выбранных версиях; история «кто, что и когда решил» сохраняется. Нужны законное основание и номер
        обращения; при удержании заседания-источника удаление запрещено.
      </p>
      {error ? <p className="notice error">{errorText(error)}</p> : null}
      {data ? (
        <>
          <p className="xs faint">
            Проверено мест: {data.scanned}. {data.note}
          </p>
          {data.findings.length ? (
            <ul className="plain k-list">
              {data.findings.map((f) => (
                <li key={f.id}>
                  {f.readable ? <a href={`#/library/${f.id}`}>{f.title}</a> : <span className="k-closed">{f.title}</span>} <span className="xs faint">{f.hall}</span>
                  <ul className="plain">
                    {f.places.map((p) => (
                      <li key={key(f.id, p.loc)}>
                        <label className="check small">
                          <input
                            type="checkbox"
                            checked={picked.has(key(f.id, p.loc))}
                            onChange={(e) => {
                              const next = new Set(picked);
                              if (e.target.checked) next.add(key(f.id, p.loc));
                              else next.delete(key(f.id, p.loc));
                              setPicked(next);
                            }}
                          />
                          {p.place}: {p.kinds.join(', ')}
                        </label>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">Персональных данных по шаблонам не найдено.</p>
          )}
          <div className="grid-2">
            <div className="field">
              <label htmlFor="kp-basis">Законное основание</label>
              <select id="kp-basis" className="select" value={basis} onChange={(e) => setBasis(e.target.value)}>
                {data.bases.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="kp-ref">Номер обращения или документа</label>
              <input id="kp-ref" className="input" maxLength={80} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="например: запрос ПДн №14/2026" />
              <span className="hint">Попадает в постоянный журнал — без имён и других персональных данных.</span>
            </div>
          </div>
          {err ? (
            <p className="notice error" role="alert">
              {err}
            </p>
          ) : null}
          <div className="row">
            <button className="btn danger" disabled={busy || !picked.size || ref.trim().length < 3} onClick={() => void run(eraseSelected, 'Сведения удалены из всех выбранных мест')}>
              Удалить выбранные сведения ({picked.size})
            </button>
          </div>
          <div className="row">
            <select className="select" aria-label="Сотрудник для обезличивания" value={member} onChange={(e) => setMember(e.target.value)}>
              <option value="">Сотрудник…</option>
              {members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={busy || !member || ref.trim().length < 3}
              onClick={() => void run(() => api(`/orgs/${s.org}/members/${member}/pseudonymize`, { method: 'POST', json: { basis, ref } }), 'Сотрудник обезличен в знаниях')}
            >
              Обезличить в знаниях
            </button>
            <span className="xs faint">Ссылки на человека убираются из всех карточек, фамилия в тексте удаляется, вместо имени — «Сотрудник (обезличен)».</span>
          </div>
          {data.log.length ? (
            <details>
              <summary className="small">Журнал удалений ({data.log.length})</summary>
              <ul className="plain k-list">
                {data.log.map((l) => (
                  <li key={l.id} className="small">
                    {dateTime(l.at)}: {l.scope}, мест: {l.places}, изменено строк: {l.rowsChanged}. {l.basis}, {l.ref}. {l.actor}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
