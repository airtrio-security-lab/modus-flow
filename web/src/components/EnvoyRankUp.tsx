import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { outfit, outfitWords, type Piece } from '../lib/envoy-outfits';
import type { MyEnvoy } from '../lib/types';
import { EnvoyAvatar } from './EnvoyAvatar';

/**
 * «Ваш посол достиг ранга …!» (ADR-0032). Shown to the envoy's owner for a rank-up the server has
 * RECORDED and the person has not seen yet — so a rank-up reached while away waits for the next login,
 * and is played ONCE: after 1.5 s on a visible screen the existing notification is marked read
 * (POST /notifications/read), so a reload does not replay it. It is a card, not a modal: navigation stays
 * usable, «Пропустить» closes it at once. Watching awards nothing.
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

  // The card keeps what it announced, even after the server answers «read» on the next poll.
  const [showing, setShowing] = useState<{ pending: NonNullable<MyEnvoy['pending']>; civ: string; membershipId: string } | null>(null);
  useEffect(() => {
    if (!showing && data?.pending && data.pending.notificationId !== closed) {
      setShowing({ pending: data.pending, civ: data.civilization, membershipId: data.membershipId });
    }
  }, [data, showing, closed]);
  const pending = showing?.pending ?? null;

  // Shown once: after the person has really had it on screen, the existing notification is marked read,
  // so the next login or a reload does not play it again (the profile and the inbox keep the fact).
  // Every picture of this person's envoy is redrawn at once (the map listens to this event).
  const markRead = useCallback(async (id: string) => {
    await api(`/orgs/${s.org}/notifications/read`, { json: { ids: [id] } }).catch(() => undefined);
    await s.refreshInbox();
  }, [s]);
  useEffect(() => {
    if (!pending) return;
    window.dispatchEvent(new CustomEvent('modus:envoy-rank', { detail: { rank: pending.rank } }));
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = window.setTimeout(() => void markRead(pending.notificationId), 1500);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [pending, markRead]);

  const close = useCallback(async () => {
    if (!pending) return;
    setClosed(pending.notificationId);
    setShowing(null);
    await markRead(pending.notificationId);
  }, [pending, markRead]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, close]);

  if (!pending || !showing) return null;
  const civ = showing.civ;
  const now = outfit(civ, pending.rank);
  const before = outfit(civ, pending.rank - 1);
  const added = now.pieces.filter((p) => !before.pieces.includes(p)).map((p) => PIECE_WORDS[p]).filter(Boolean);
  const rankLabel = `Посол ранга ${pending.name}: ${outfitWords(now)}`;
  return (
    <div className="envoy-rankup" ref={ref} role="status" aria-live="polite" aria-label={pending.text}>
      <div className="envoy-rankup-stage" aria-hidden="true">
        <span className="envoy-rankup-flash" />
        <span className="envoy-rankup-old">
          <EnvoyAvatar civ={civ} rank={pending.rank - 1} variant="profile" size={112} />
        </span>
        <span className="envoy-rankup-new">
          <EnvoyAvatar civ={civ} rank={pending.rank} variant="profile" size={112} />
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
          <a className="btn small primary" href={`#/people/${showing.membershipId}?section=envoy`} onClick={() => void close()}>
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
