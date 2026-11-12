import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Directory, Me, Notification, Role } from './types';

export interface Session {
  me: Me;
  org: string;
  /** The real company name: administration, documents, legal identification. */
  orgName: string;
  /** The game world's name (ADR-0021): the organization's commonwealth, configurable by its admin. */
  realmName: string;
  membershipId: string;
  roles: Role[];
  isLead: boolean;
  isAdmin: boolean;
  /** Curation of organizational memory. Opens no material by itself. */
  isArchivist: boolean;
  directory: Directory | null;
  reloadDirectory: () => Promise<void>;
  unread: number;
  refreshInbox: () => Promise<void>;
  /** The reader's own notifications and audiences from the last refresh (cinematic notifications, ADR-0031). */
  feed: InboxFeed | null;
  toast: (text: string) => void;
  signOut: () => void;
}

export interface FeedAudience {
  id: string;
  ideaNumber: number;
  title: string;
  role: 'king' | 'sender';
  status: 'requested' | 'accepted';
  requestedAt: string;
  acceptedAt: string | null;
}
export interface InboxFeed {
  notes: Notification[];
  audiences: FeedAudience[];
  king: string | null;
  /** False when the audiences could not be read: nothing is concluded about them. */
  audiencesOk: boolean;
  at: number;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

export function SessionProvider({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const m = me.memberships[0]!;
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [unread, setUnread] = useState(0);
  const [feed, setFeed] = useState<InboxFeed | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const reloadDirectory = useCallback(async () => {
    setDirectory(await api<Directory>(`/orgs/${m.organization}/directory`));
  }, [m.organization]);
  const refreshInbox = useCallback(async () => {
    try {
      const list = await api<Notification[]>(`/orgs/${m.organization}/notifications`);
      // An audience is a separate, server-confirmed event. Include its pending
      // invitation (king) or unseen acceptance (sender) in the bell count.
      let audiencesOk = true;
      const audiences = await api<{ king: { membershipId: string } | null; items: FeedAudience[] }>(`/orgs/${m.organization}/audiences`).catch(() => {
        audiencesOk = false;
        return { king: null, items: [] as FeedAudience[] };
      });
      const outstanding = audiences.items.filter((a) => {
        if (a.role === 'king') return a.status === 'requested';
        if (a.status !== 'accepted') return false;
        try {
          return sessionStorage.getItem('modus.audience.seen:' + m.organization + ':' + m.membershipId + ':' + a.id) !== '1';
        } catch { return true; }
      }).length;
      setUnread(list.filter((n) => !n.readAt).length + outstanding);
      setFeed({ notes: list, audiences: audiences.items, king: audiences.king?.membershipId ?? null, audiencesOk, at: Date.now() });
    } catch {
      /* the counter is a convenience; the inbox page shows errors */
    }
  }, [m.organization]);

  useEffect(() => {
    void reloadDirectory().catch(() => undefined);
    void refreshInbox();
    const t = window.setInterval(() => void refreshInbox(), 30000);
    return () => window.clearInterval(t);
  }, [reloadDirectory, refreshInbox]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastText(null), 4200);
  }, []);

  const value = useMemo<Session>(() => {
    const roles = m.roles;
    return {
      me,
      org: m.organization,
      orgName: m.organizationName,
      realmName: m.realmName ?? 'Великое Содружество',
      membershipId: m.membershipId,
      roles,
      isLead: roles.includes('maintainer') || roles.includes('decision_owner'),
      isAdmin: roles.includes('org_admin'),
      isArchivist: roles.includes('archivist'),
      directory,
      reloadDirectory,
      unread,
      refreshInbox,
      feed,
      toast,
      signOut: onSignOut,
    };
  }, [me, m, directory, reloadDirectory, unread, refreshInbox, feed, toast, onSignOut]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {toastText && (
        <div className="toast" role="status" aria-live="polite">
          {toastText}
        </div>
      )}
    </Ctx.Provider>
  );
}

/** Small data hook: load, reload, error. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}
