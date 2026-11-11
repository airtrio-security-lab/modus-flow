import { useState } from 'react';
import { api, errorText } from '../lib/api';
import { ago, dateTime } from '../lib/format';
import { go } from '../lib/router';
import { useLite } from '../lib/lite';
import { useLoad, useSession } from '../lib/session';
import type { NoteCategory, NotePreferences, Notification } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/**
 * «Королевские послания» — the notification center (ADR-0016). Every message comes from a
 * real event and only reaches people who take part; the game headline and wording follow
 * the reader's own choice, the plain business text below is always there. Urgent unread
 * messages unfold once, briefly, without blocking anything (not in the light mode and not
 * with reduced motion).
 */
const FILTERS: { id: 'all' | 'unread' | NoteCategory; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'unread', label: 'Непрочитанные' },
  { id: 'council', label: 'Совет' },
  { id: 'items', label: 'Обращения' },
  { id: 'decisions', label: 'Решения и поручения' },
  { id: 'deadlines', label: 'Сроки' },
  { id: 'castle', label: 'Замок' },
  { id: 'legacy', label: 'Наследие' },
];
const SEAL: Record<NoteCategory, string> = { council: '#8a1c1c', items: '#0e7469', decisions: '#6a4a86', deadlines: '#b45309', castle: '#8a6a12', legacy: '#2f4a7a' };

function Seal({ category }: { category: NoteCategory }) {
  return (
    <svg className="seal" viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
      <path d="M8 6h20a4 4 0 0 1 4 4v22H12a4 4 0 0 1-4-4z" fill="#f4ead2" stroke="#b9a37a" />
      <path d="M12 12h14M12 17h14M12 22h9" stroke="#b9a37a" strokeWidth="1.5" />
      <circle cx="28" cy="29" r="8.5" fill={SEAL[category]} />
      <path d="M24 31l1.4-5 2.6 2.4 2.6-2.4 1.4 5z" fill="#f4ead2" opacity=".85" />
    </svg>
  );
}

interface Group {
  head: Notification;
  more: Notification[];
}
function group(list: Notification[], on: boolean): Group[] {
  if (!on) return list.map((head) => ({ head, more: [] }));
  const out: Group[] = [];
  for (const n of list) {
    const prev = out.at(-1);
    const same =
      prev &&
      prev.head.event === n.event &&
      prev.head.ideaNumber === n.ideaNumber &&
      prev.head.meetingId === n.meetingId &&
      Math.abs(new Date(prev.head.createdAt).getTime() - new Date(n.createdAt).getTime()) < 24 * 3600e3;
    if (same) prev.more.push(n);
    else out.push({ head: n, more: [] });
  }
  return out;
}

export function Inbox() {
  const s = useSession();
  const [lite] = useLite();
  const { data, error, loading, reload } = useLoad(() => api<Notification[]>(`/orgs/${s.org}/notifications`), [s.org]);
  const prefs = useLoad(() => api<NotePreferences>(`/orgs/${s.org}/me/notification-preferences`), [s.org]).data;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seen] = useState(() => new Set<string>());
  const unread = (data ?? []).filter((n) => !n.readAt);

  async function markRead(ids: string[]) {
    if (!ids.length) return;
    await api(`/orgs/${s.org}/notifications/read`, { json: { ids } }).catch(() => undefined);
    await reload();
    await s.refreshInbox();
  }
  /** «Войти в Совет» passes through the city: the camera flies to the palace (skippable, instant in light graphics). */
  const councilEntry = (path: string, dept?: string | null) => `/kingdom?enter=${encodeURIComponent(path.replace(/^#/, ''))}${dept ? `&hall=${dept}` : ''}`;
  async function open(n: Notification, path: string, also: Notification[] = []) {
    const ids = [n, ...also].filter((x) => !x.readAt).map((x) => x.id);
    if (ids.length) await markRead(ids);
    go(path);
  }
  async function attend(n: Notification, attendance: 'confirmed' | 'declined') {
    setBusy(n.id);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/meetings/${n.meetingId}/attendance`, { json: { attendance } });
      s.toast(attendance === 'confirmed' ? 'Участие подтверждено' : 'Организатор увидит, что вы не сможете присутствовать');
      await markRead([n.id]);
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(null);
    }
  }

  const shown = (data ?? []).filter((n) => filter === 'all' || (filter === 'unread' ? !n.readAt : n.category === filter));
  const groups = group(shown, prefs?.groupRepeats ?? true);
  return (
    <div className="stack-lg">
      <PageHead
        title={prefs?.style === 'business' ? 'Уведомления' : 'Королевские послания'}
        sub="Только о том, в чём вы участвуете. Деловой текст — в каждом послании; стиль и обращение настраиваются в профиле."
      >
        {unread.length > 0 && (
          <button className="btn small" onClick={() => void markRead(unread.map((n) => n.id))}>
            Отметить все прочитанными
          </button>
        )}
      </PageHead>
      <div className="segmented wrap" role="group" aria-label="Какие послания показать">
        {FILTERS.map((x) => (
          <button key={x.id} type="button" aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>
            {x.label}
            {x.id === 'unread' && unread.length ? ` (${unread.length})` : ''}
          </button>
        ))}
      </div>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {err ? <p className="notice error">{err}</p> : null}
      {loading && !data ? (
        <Loading />
      ) : groups.length ? (
        <ol className="scrolls">
          {groups.map(({ head: n, more }) => {
            const fresh = !n.readAt && n.urgent && !lite && !seen.has(n.id);
            seen.add(n.id);
            const m = n.meeting;
            const target = n.knowledgeId ? `/library/${n.knowledgeId}` : n.meetingId ? (m?.ideaNumber ? `/council/${m.ideaNumber}` : `/meetings/${n.meetingId}`) : n.ideaNumber ? `/items/${n.ideaNumber}` : null;
            return (
              <li key={n.id} className={`scroll${n.readAt ? '' : ' unread'}${fresh ? ' unfold' : ''}`} data-category={n.category}>
                <Seal category={n.category} />
                <div className="scroll-body">
                  <div className="scroll-top">
                    <h2 className="scroll-h">{n.headline}</h2>
                    <span className="small muted">
                      <time dateTime={n.createdAt} title={dateTime(n.createdAt)}>
                        {ago(n.createdAt)}
                      </time>
                      {' · '}
                      {n.readAt ? 'прочитано' : <b className="unread-mark">новое</b>}
                      {more.length ? ` · ещё ${more.length} похожих` : ''}
                    </span>
                  </div>
                  {n.royal ? <p className="scroll-royal">{n.royal}</p> : null}
                  <p className="scroll-business">{n.message}</p>
                  {m ? (
                    <dl className="scroll-facts">
                      <div>
                        <dt>Тема</dt>
                        <dd>{m.title}</dd>
                      </div>
                      <div>
                        <dt>Где</dt>
                        <dd>{m.council === 'great' ? 'Большой Круглый стол — совет компании' : `${m.hall} — малый совет подразделения`}</dd>
                      </div>
                      <div>
                        <dt>Созвал(а)</dt>
                        <dd>{m.organizer}</dd>
                      </div>
                      <div>
                        <dt>Когда</dt>
                        <dd>{m.scheduledAt ? dateTime(m.scheduledAt) : 'время не назначено'}</dd>
                      </div>
                      {m.ideaNumber ? (
                        <div>
                          <dt>Обращение</dt>
                          <dd>
                            №{m.ideaNumber}
                            {m.ideaTitle ? ` «${m.ideaTitle}»` : ''}
                          </dd>
                        </div>
                      ) : null}
                      {m.agenda.length ? (
                        <div>
                          <dt>Повестка</dt>
                          <dd>
                            {m.agenda.map((a, i) => (
                              <span key={a.number}>
                                {i ? '; ' : ''}
                                <a href={`#/items/${a.number}`}>№{a.number}</a> {a.title}
                              </span>
                            ))}
                          </dd>
                        </div>
                      ) : null}
                      <div>
                        <dt>Почему вы</dt>
                        <dd>{m.reason}</dd>
                      </div>
                      <div>
                        <dt>Участие</dt>
                        <dd>{m.required ? 'ожидается: заседание созвал руководитель с правом решения' : 'по желанию'}</dd>
                      </div>
                      <div>
                        <dt>Что сделать</dt>
                        <dd>{m.cancelled ? `Заседание отменено${m.cancelReason ? `: ${m.cancelReason}` : ''}` : m.action}</dd>
                      </div>
                    </dl>
                  ) : n.meetingClosed ? (
                    <p className="small muted">Вас больше нет среди участников этого заседания — доступ к нему закрыт.</p>
                  ) : null}
                  <div className="row">
                    {m && !m.cancelled ? (
                      <>
                        <button className="btn primary small" onClick={() => void open(n, councilEntry(target!, m.departmentId), more)}>
                          Войти в Совет
                        </button>
                        {m.attendance !== 'confirmed' ? (
                          <button className="btn small" disabled={busy === n.id} onClick={() => void attend(n, 'confirmed')}>
                            Подтвердить участие
                          </button>
                        ) : (
                          <span className="seat-pill tone-pro">участие подтверждено</span>
                        )}
                        {m.attendance !== 'declined' ? (
                          <button className="btn small" disabled={busy === n.id} onClick={() => void attend(n, 'declined')}>
                            Не могу присутствовать
                          </button>
                        ) : (
                          <span className="seat-pill tone-con">не смогу</span>
                        )}
                        <button className="btn quiet small" onClick={() => void open(n, m.ideaNumber ? `/items/${m.ideaNumber}` : `/meetings/${n.meetingId}`, more)}>
                          Ознакомиться с вопросом
                        </button>
                      </>
                    ) : target && !n.meetingClosed ? (
                      <button className="btn small" onClick={() => void open(n, target, more)}>
                        {n.knowledgeId ? 'Открыть в Великой библиотеке' : n.ideaNumber ? `Открыть обращение №${n.ideaNumber}` : 'Открыть'}
                      </button>
                    ) : !n.readAt ? (
                      <button className="btn quiet small" onClick={() => void markRead([n.id, ...more.map((x) => x.id)])}>
                        Прочитано
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="empty">{filter === 'all' ? 'Посланий нет. Здесь появятся вызовы на Совет, решения, поручения и сроки.' : 'В этом разделе посланий нет.'}</div>
      )}
    </div>
  );
}
