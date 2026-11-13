import { useRef, useState } from 'react';
import { api, errorText, newKey } from '../lib/api';
import { date } from '../lib/format';
import { useSession } from '../lib/session';
import type { Contribution } from '../lib/types';

/**
 * One line of «Вклад» in the item passport (ADR-0042). Everyone sees whether a contribution was
 * confirmed and by whom. The item's maintainer or decision owner — never the contributor — may
 * confirm someone else's recorded contribution; the server decides (`canConfirm`) and checks again.
 * Confirming cannot be undone, so it takes a second, explicit step. It awards no XP and grants nothing;
 * the contributor gets one notification «Вклад подтверждён».
 */
export function ContributionLine({
  c,
  label,
  number,
  reload,
}: {
  c: Contribution;
  label: string;
  number: number;
  reload: () => Promise<void>;
}) {
  const s = useSession();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());

  async function confirm() {
    if (!c.id) return;
    setBusy(true);
    try {
      await api(`/orgs/${s.org}/ideas/${number}/contributions/${c.id}/confirm`, { method: 'POST', json: {}, key: key.current });
      s.toast(`Вклад подтверждён: ${c.member} получит уведомление`);
      setAsking(false);
      await reload();
    } catch (e) {
      s.toast(errorText(e));
      key.current = newKey();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="credit-line">
      <span>
        {c.member} <span className="faint">— {label}</span>
      </span>
      {c.status === 'confirmed' && (
        <span className="credit-confirmed small" title={c.confirmedAt ? `Подтвердил(а) ${c.confirmedBy ?? '—'}, ${date(c.confirmedAt)}` : undefined}>
          ✓ подтверждён{c.confirmedBy ? `: ${c.confirmedBy}` : ''}
        </span>
      )}
      {c.status === 'recorded' && c.canConfirm && !asking && (
        <button type="button" className="btn quiet small" onClick={() => setAsking(true)}>
          Подтвердить вклад
        </button>
      )}
      {c.status === 'recorded' && c.canConfirm && asking && (
        <span className="credit-ask" role="group" aria-label={`Подтвердить вклад: ${c.member}`}>
          <span className="small">Подтвердить вклад «{label}»? Отменить нельзя.</span>
          <button type="button" className="btn primary small" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Подтверждаем…' : 'Да, подтвердить'}
          </button>
          <button type="button" className="btn quiet small" disabled={busy} onClick={() => setAsking(false)}>
            Отмена
          </button>
        </span>
      )}
    </li>
  );
}
