import { useEffect, useMemo, useState } from 'react';
import { useSession } from './session';
import { WORLD_RETURN_EVENT, readWorldContext, reconcile, returnLabel } from './worldReturn';

/**
 * The way back into the game world for the screen the person is on (ADR-0038): the world screen they
 * came from, or null when they did not come from the world in this tab. `fallback` is for screens that
 * always offer the city (the Great Library).
 */
export function useWorldBack(): { href: string; label: string } | null {
  const s = useSession();
  const who = useMemo(() => ({ org: s.org, member: s.membershipId }), [s.org, s.membershipId]);
  const [ctx, setCtx] = useState(() => readWorldContext(who));
  useEffect(() => {
    const on = () => setCtx(readWorldContext(who));
    on();
    window.addEventListener(WORLD_RETURN_EVENT, on);
    return () => window.removeEventListener(WORLD_RETURN_EVENT, on);
  }, [who]);
  return useMemo(() => {
    if (!ctx?.from) return null;
    const departments = s.directory?.departments.filter((d) => d.active) ?? null;
    // Until the directory is read nothing is concluded about a department: the city is always there.
    const checked = departments ? reconcile(ctx, departments.map((d) => d.id)) : ctx;
    const from = checked.from ?? '#/kingdom';
    return { href: from, label: returnLabel(from, departments ?? []) };
  }, [ctx, s.directory]);
}
