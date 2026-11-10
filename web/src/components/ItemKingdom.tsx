import { useRef, useState } from 'react';
import { api, newKey } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import type { IdeaDetail, IdeaProgress } from '../lib/types';
import { ErrorBox } from './ui';

/**
 * The bridge from the business card to the game view (ADR-0012): an item under
 * consideration links to its Council session; an implemented item shows what
 * it brought to its department's castle, and its decision owner may confirm
 * the documented effect (bonus up to the organization's maximum, once).
 */
const IN_COUNCIL = ['unrouted', 'in_review', 'needs_info', 'in_verification', 'decision'];

export function ItemKingdom({ item }: { item: IdeaDetail }) {
  const s = useSession();
  const implemented = item.status === 'implemented' || item.status === 'in_progress';
  const { data, error, reload } = useLoad(
    () => (implemented ? api<IdeaProgress>(`/orgs/${s.org}/ideas/${item.number}/progress`) : Promise.resolve(null)),
    [s.org, item.number, item.status],
  );

  if (IN_COUNCIL.includes(item.status)) {
    return (
      <div className="item-kingdom">
        <span>Обсуждение обращения идёт в Совете: аргументы, рекомендации и решение ответственного.</span>
        <a className="btn" href={`#/council/${item.number}`}>
          Открыть Совет
        </a>
      </div>
    );
  }
  if (!implemented) return null;
  if (error) return <ErrorBox error={error} retry={() => void reload()} />;
  if (!data) return null;
  const xp = data.awards.reduce((n, a) => n + a.xp, 0);
  const castle = item.department ? `замку «${item.department}»` : 'королевству';
  return (
    <div className="item-kingdom stack">
      {xp ? (
        <span>
          Внедрение подтверждено: {castle} начислено <b>+{xp} XP</b>
          {data.effect ? ` (из них за подтверждённый эффект +${data.effect.xp}, подтвердил(а) ${data.effect.approvedBy})` : ''}.{' '}
          <a href="#/kingdom">Открыть королевство</a>
        </span>
      ) : (
        <span>Опыт замку начисляется, когда внедрение подтверждено. Сейчас идёт внедрение.</span>
      )}
      {data.canApproveEffect ? <EffectForm number={item.number} max={data.effectMax} onDone={reload} /> : null}
    </div>
  );
}

function EffectForm({ number, max, onDone }: { number: number; max: number; onDone: () => Promise<void> }) {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const [xp, setXp] = useState(max);
  const [rationale, setRationale] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const key = useRef(newKey());
  if (!open)
    return (
      <div className="row">
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          Подтвердить эффект
        </button>
        <span className="small muted">Бонус до +{max} XP за документально подтверждённый результат. Подтверждается один раз.</span>
      </div>
    );
  return (
    <form
      className="stack council-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await api(`/orgs/${s.org}/ideas/${number}/effect`, { method: 'POST', json: { xp, rationale: rationale.trim() }, key: key.current });
          s.toast(`Эффект подтверждён: +${xp} XP`);
          setOpen(false);
          await onDone();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="field">
        <label htmlFor="ef-xp">Бонус, XP (0–{max})</label>
        <input id="ef-xp" className="input" type="number" min={0} max={max} value={xp} onChange={(e) => setXp(Math.max(0, Math.min(max, Number(e.target.value) || 0)))} />
      </div>
      <div className="field">
        <label htmlFor="ef-why">Что подтверждено и каким документом</label>
        <textarea id="ef-why" className="textarea" rows={3} value={rationale} onChange={(e) => setRationale(e.target.value)} maxLength={3000} />
        <span className="hint">Не меньше 20 символов. Например: «Пересортов за месяц — 0 против 6, акт инвентаризации от 30.11».</span>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      <div className="row">
        <button className="btn primary" type="submit" disabled={busy || rationale.trim().length < 20}>
          Подтвердить эффект: +{xp} XP
        </button>
        <button className="btn quiet" type="button" onClick={() => setOpen(false)}>
          Отмена
        </button>
      </div>
    </form>
  );
}
