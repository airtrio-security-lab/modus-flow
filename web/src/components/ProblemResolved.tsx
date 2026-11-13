import { useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { date } from '../lib/format';
import { useLoad, useSession } from '../lib/session';
import type { IdeaDetail } from '../lib/types';
import { ErrorBox } from './ui';

/**
 * «Проблема решена?» (ADR-0035): for a problem whose implementation was confirmed, the person whose
 * question it is says whether the problem is really gone. One confirmation per item, +5 XP to their
 * envoy — written by the database, not by this screen. Nobody else can confirm it for them; nothing
 * here changes the stage, the castle or anyone's rights.
 */
interface Resolution {
  number: number;
  applies: boolean;
  implemented: boolean;
  confirmed: { at: string; by: string } | null;
  canConfirm: boolean;
  xp: number;
}

export function ProblemResolved({ item }: { item: IdeaDetail }) {
  const s = useSession();
  const relevant = item.kind === 'problem' && (item.status === 'implemented' || item.status === 'in_progress');
  const { data, error, reload } = useLoad(
    () => (relevant ? api<Resolution>(`/orgs/${s.org}/ideas/${item.number}/resolution`) : Promise.resolve(null)),
    [s.org, item.number, item.status],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const key = useRef(newKey());
  if (!relevant) return null;
  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (!data || !data.applies || !data.implemented) return null;
  if (data.confirmed) {
    return (
      <p className="notice problem-resolved" role="note">
        ✓ {data.confirmed.by} подтвердил(а), что проблема решена — {date(data.confirmed.at)}.
      </p>
    );
  }
  if (!data.canConfirm) {
    return <p className="small muted">Внедрение подтверждено. Решена ли проблема, подтверждает тот, кто её поднял.</p>;
  }
  async function confirm() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orgs/${s.org}/ideas/${item.number}/resolution`, { method: 'POST', json: {}, key: key.current });
      await reload();
      s.toast(`Спасибо: решение проблемы подтверждено, послу +${data!.xp} XP`);
      await s.refreshInbox();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="problem-resolve stack-sm" aria-labelledby="problem-resolve-h">
      <h2 id="problem-resolve-h" className="section-title">Проблема решена?</h2>
      <p className="small">
        Вы подняли этот вопрос, и внедрение уже подтверждено. Если проблемы больше нет — подтвердите: вашему послу +{data.xp} XP, один раз. Если
        не решена — ничего не нажимайте и напишите об этом в обсуждении.
      </p>
      {err ? <ErrorBox error={err} /> : null}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>
        {busy ? 'Подтверждаем…' : 'Да, проблема решена'}
      </button>
    </section>
  );
}
