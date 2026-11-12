import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { outfit, outfitWords, type Piece } from '../lib/envoy-outfits';
import type { MyEnvoy } from '../lib/types';
import { EnvoyPortrait } from './EnvoyFigure';

/**
 * «Ваш посол достиг ранга …!» (ADR-0032). Shown to the envoy's owner for a rank-up the server has
 * RECORDED and the person has not opened yet — so it is still there after the next login. It is a card,
 * not a modal: navigation stays usable, «Пропустить» closes it at once. Closing marks the existing
 * notification read (POST /notifications/read) — watching the animation awards nothing.
 * The ceremony (flash, change of attire, new insignia) is CSS and stops in the light mode and under
 * prefers-reduced-motion: then the new attire is simply shown.
 */
const PIECE_WORDS: Partial<Record<Piece, string>> = {
  belt: 'пояс',
  clasp: 'застёжка плаща',
  crest: 'герб подразделения',
  seal: 'официальная печать',
  staff: 'жезл',
  banner: 'знамя',
  chain: 'золотая цепь',
  'ornate-scroll': 'украшенный свиток',
  embroidery: 'вышивка',
  'gold-staff': 'золотой жезл',
  insignia: 'знаки отличия',
  fur: 'меховая опушка',
  medallion: 'медальон Содружества',
  'commonwealth-standard': 'штандарт Содружества',
  'commonwealth-ring': 'кольцо Великого Содружества',
};

export function EnvoyRankUp() {
  const s = useSession();
  const [data, setData] = useState<MyEnvoy | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let gone = false;
    api<MyEnvoy>(`/orgs/${s.org}/me/envoy`)
      .then((d) => !gone && setData(d))
      .catch(() => undefined); // a convenience: the profile and the inbox show the same facts
    return () => {
      gone = true;
    };
    // The inbox poll changes `unread`; a new rank-up arrives with it.
  }, [s.org, s.unread]);

  const pending = data?.pending && data.pending.notificationId !== closed ? data.pending : null;
  const close = useCallback(async () => {
    if (!pending) return;
    setClosed(pending.notificationId);
    await api(`/orgs/${s.org}/notifications/read`, { json: { ids: [pending.notificationId] } }).catch(() => undefined);
    await s.refreshInbox();
  }, [pending, s]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  if (!pending || !data) return null;
  const now = outfit(data.civilization, pending.rank);
  const before = outfit(data.civilization, pending.rank - 1);
  const added = now.pieces.filter((p) => !before.pieces.includes(p)).map((p) => PIECE_WORDS[p]).filter(Boolean);
  const rankLabel = `Посол ранга ${pending.name}: ${outfitWords(now)}`;
  return (
    <div className="envoy-rankup" ref={ref} role="status" aria-live="polite" aria-label={pending.text}>
      <div className="envoy-rankup-stage" aria-hidden="true">
        <span className="envoy-rankup-flash" />
        <span className="envoy-rankup-old">
          <EnvoyPortrait civ={data.civilization} rank={pending.rank - 1} size={112} />
        </span>
        <span className="envoy-rankup-new">
          <EnvoyPortrait civ={data.civilization} rank={pending.rank} size={112} />
        </span>
      </div>
      <div className="envoy-rankup-copy">
        <p className="envoy-rankup-kicker">Путь Посла · ранг {roman(pending.rank)} из VII</p>
        <h2 className="envoy-rankup-title">{pending.text}</h2>
        <p className="small">{rankLabel}.</p>
        {added.length ? <p className="small envoy-rankup-new-piece">Новый знак: {added.join(', ')}.</p> : null}
        <p className="small muted">
          {pending.number ? `Основание — подтверждённый результат обращения №${pending.number}. ` : ''}Ранг отражает вклад и полномочий не даёт.
        </p>
        <div className="row-tight">
          <a className="btn small primary" href={`#/people/${data.membershipId}?section=envoy`} onClick={() => void close()}>
            Открыть карточку посла
          </a>
          <button type="button" className="btn small quiet" onClick={() => void close()}>
            Пропустить
          </button>
        </div>
      </div>
    </div>
  );
}

export const roman = (n: number) => ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][Math.max(1, Math.min(7, n)) - 1]!;
