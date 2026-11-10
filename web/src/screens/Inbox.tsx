import { api } from '../lib/api';
import { ago } from '../lib/format';
import { go } from '../lib/router';
import { useLoad, useSession } from '../lib/session';
import type { Notification } from '../lib/types';
import { ErrorBox, Loading, PageHead } from '../components/ui';

/** Notifications: only about items you take part in (enforced by the database). */
export function Inbox() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<Notification[]>(`/orgs/${s.org}/notifications`), [s.org]);
  const unread = (data ?? []).filter((n) => !n.readAt);

  async function markRead(ids: string[]) {
    if (!ids.length) return;
    await api(`/orgs/${s.org}/notifications/read`, { json: { ids } }).catch(() => undefined);
    await reload();
    await s.refreshInbox();
  }
  async function openOne(n: Notification) {
    if (!n.readAt) await markRead([n.id]);
    if (n.ideaNumber) go(`/items/${n.ideaNumber}`);
  }

  return (
    <div className="stack-lg">
      <PageHead title="Уведомления" sub="Только об обращениях, в которых вы участвуете.">
        {unread.length > 0 && (
          <button className="btn small" onClick={() => void markRead(unread.map((n) => n.id))}>
            Отметить все прочитанными
          </button>
        )}
      </PageHead>
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="list">
          {!data?.length && <div className="empty">Уведомлений нет. Здесь появятся ответы на ваши обращения и новые задачи.</div>}
          {data?.map((n) => (
            <button key={n.id} className={`list-row note${n.readAt ? '' : ' unread'}`} onClick={() => void openOne(n)}>
              <span className="num">{n.ideaNumber ? `№${n.ideaNumber}` : ''}</span>
              <span className="title">{n.message}</span>
              <span className="side xs faint">{ago(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
