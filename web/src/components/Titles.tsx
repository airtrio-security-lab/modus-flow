import { api } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { GameTitle, TitlesView } from '../lib/types';

/**
 * Game titles (ADR-0014). Shown next to the real job title, never instead of it,
 * and always with the reminder that a title grants no rights.
 */
export function useTitles() {
  const s = useSession();
  // Guests get 403 here and simply see no titles.
  const { data, reload } = useLoad(() => api<TitlesView>(`/orgs/${s.org}/titles`), [s.org]);
  const map = new Map<string, GameTitle>((data?.titles ?? []).map((t) => [t.membershipId, t]));
  return { data, reload, get: (membershipId: string) => map.get(membershipId) ?? null };
}

export function TitleChip({ title }: { title: GameTitle | null }) {
  if (!title) return null;
  return (
    <span className={`title-chip rank-${title.rank}`} title="Игровое звание. Прав в системе не даёт.">
      {title.title}
    </span>
  );
}
