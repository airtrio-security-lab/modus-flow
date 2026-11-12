import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { ago } from '../lib/format';
import { useLite } from '../lib/lite';
import { useSession, useLoad } from '../lib/session';
import type { IdeaDetail, MyEnvoy, NotePreferences } from '../lib/types';
import { EnvoyAvatar } from './EnvoyAvatar';

/** An audience is ceremonial. Decisions and meetings remain separate, authorized workflows. */
export interface Audience {
  id: string;
  ideaNumber: number;
  title: string;
  requesterName: string;
  role: 'sender' | 'king';
  status: 'requested' | 'accepted';
  requestedAt: string;
  acceptedAt: string | null;
  canDecide: boolean;
  canConvene: boolean;
  canReview: boolean;
}
export interface AudienceInboxData {
  king: { membershipId: string; name: string } | null;
  items: Audience[];
}

/** An opt-in shortcut on the employee's own submitted idea. */
export function EnvoyShortcut({ item }: { item: IdeaDetail }) {
  const s = useSession();
  const [busy, setBusy] = useState(false);
  const [errorTextLocal, setErrorTextLocal] = useState('');
  const { data, reload } = useLoad(() => api<AudienceInboxData>('/orgs/' + s.org + '/audiences'), [s.org]);
  // «Путь Посла» (ADR-0032): the sender's own envoy in its current attire; the audience itself awards nothing.
  const mine = useLoad(() => api<MyEnvoy>('/orgs/' + s.org + '/me/envoy'), [s.org]).data;
  const owned = item.author.membershipId === s.membershipId || item.raisedByMembershipId === s.membershipId;
  if (!owned) return null;
  const record = data?.items.find((a) => a.role === 'sender' && a.ideaNumber === item.number);
  if (!record && (item.stage === 'closed' || data && (!data.king || data.king.membershipId === s.membershipId))) return null;

  async function send() {
    setBusy(true);
    setErrorTextLocal('');
    try {
      await api('/orgs/' + s.org + '/ideas/' + item.number + '/audience', { json: {} });
      await reload();
      s.toast('Посол направлен Королю с просьбой об аудиенции');
      await s.refreshInbox();
    } catch (error) {
      setErrorTextLocal(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="audience-shortcut" aria-label="Посольство">
      {mine ? (
        <span className="audience-symbol audience-envoy">
          <EnvoyAvatar civ={mine.civilization} rank={mine.rank} variant="map" size={64} label={`Ваш посол: ${mine.name}`} />
        </span>
      ) : (
        <span className="audience-symbol" aria-hidden="true">♜</span>
      )}
      <div className="audience-shortcut-copy">
        <strong>Королевская аудиенция</strong>
        <p className="small">
          {record
            ? record.status === 'accepted'
              ? 'Король принял вашего посла. Откройте Королевские послания, чтобы посмотреть сцену аудиенции.'
              : 'Ваш посол ожидает аудиенции. Приём ещё не означает, что решение принято.'
            : 'Отправьте посла Королю, чтобы он ознакомился с обращением. Это не меняет его статус и не заменяет обычную маршрутизацию.'}
        </p>
        <p className="small muted">Аудиенция опыта послу не даёт: ранг растёт только от подтверждённого внедрения и измеренного эффекта.</p>
        {errorTextLocal && <p role="alert" className="notice error">{errorTextLocal}</p>}
        {record ? (
          <a className="btn small" href="#/inbox">Королевские послания</a>
        ) : (
          <button type="button" className="btn primary small" disabled={busy || !data} onClick={() => void send()}>
            {busy ? 'Отправляем посла…' : 'Отправить посла Королю'}
          </button>
        )}
      </div>
    </section>
  );
}

/** A real server-confirmed audience rendered prominently in the existing inbox. */
export function AudienceInbox() {
  const s = useSession();
  const [lite] = useLite();
  const { data, error, reload } = useLoad(() => api<AudienceInboxData>('/orgs/' + s.org + '/audiences'), [s.org]);
  const prefs = useLoad(() => api<NotePreferences>('/orgs/' + s.org + '/me/notification-preferences'), [s.org]).data;
  const business = prefs?.style === 'business';
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [playing, setPlaying] = useState<Audience | null>(null);
  const [shownOnce, setShownOnce] = useState(false);

  useEffect(() => {
    if (!data || !prefs || shownOnce) return;
    const candidate = data.items.find((a) => {
      if (a.role !== 'sender' || a.status !== 'accepted') return false;
      try {
        return sessionStorage.getItem('modus.audience.seen:' + s.org + ':' + s.membershipId + ':' + a.id) !== '1';
      } catch {
        return true;
      }
    });
    if (!candidate) return;
    setShownOnce(true);
    try {
      sessionStorage.setItem('modus.audience.seen:' + s.org + ':' + s.membershipId + ':' + candidate.id, '1');
    } catch { /* private browsing */ }
    if (!lite && prefs?.style !== 'business' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(candidate);
    void s.refreshInbox();
  }, [data, s.org, s.membershipId, s.refreshInbox, shownOnce, lite, prefs?.style]);

  async function accept(a: Audience) {
    setBusy(a.id);
    setActionError('');
    try {
      await api('/orgs/' + s.org + '/audiences/' + a.id + '/accept', { json: {} });
      await reload();
      await s.refreshInbox();
      s.toast('Король принял посла. Отправитель увидит подтверждение аудиенции.');
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="notice error" role="alert">Не удалось загрузить аудиенции: {errorText(error)}</p>;
  if (!data?.items.length) return null;

  return (
    <section className="audience-inbox" aria-label="Королевские аудиенции">
      <h2 className="section-title">{business ? 'Запросы на рассмотрение' : 'Аудиенции послов'}</h2>
      <p className="small muted">Приём посла подтверждается сервером. Решение, внедрение и созыв Совета — отдельные действия с обычной проверкой полномочий.</p>
      {actionError && <p className="notice error" role="alert">{actionError}</p>}
      <div className="audience-inbox-list">
        {data.items.map((a) => (
          <article key={a.id} className={'audience-letter ' + (a.status === 'accepted' ? 'accepted' : '')}>
            <div className="audience-letter-icon" aria-hidden="true">♜</div>
            <div className="audience-letter-body">
              <div className="row">
                <strong>{business
                  ? a.role === 'king'
                    ? a.status === 'requested' ? 'Вам поступил запрос на рассмотрение' : 'Запрос принят к ознакомлению'
                    : a.status === 'accepted' ? 'Ваш запрос принят к ознакомлению' : 'Ваш запрос направлен'
                  : a.role === 'king'
                    ? a.status === 'requested' ? 'К вам направили посла с просьбой об аудиенции' : 'Вы приняли посла на аудиенции'
                    : a.status === 'accepted' ? 'Вашего посла принял Король!' : 'Ваш посол направлен Королю'}</strong>
                <span className="small muted">{ago(a.requestedAt)}</span>
              </div>
              <p>
                Обращение №{a.ideaNumber}: <a href={'#/items/' + a.ideaNumber}>{a.title}</a>.
                {a.role === 'king' ? ' Отправитель: ' + a.requesterName + '.' : ''}
              </p>
              {a.status === 'requested' ? (
                <p className="small muted">Посол ещё не принят. Никакого решения по обращению это не означает.</p>
              ) : (
                <p className="small muted">Аудиенция подтверждена. Дальнейшее рассмотрение проходит по рабочим правилам MODUS FLOW.</p>
              )}
              <div className="row audience-actions">
                {a.role === 'king' && a.status === 'requested' && (
                  <button type="button" className="btn primary small" disabled={busy === a.id} onClick={() => void accept(a)}>
                    {busy === a.id ? 'Принимаем…' : business ? 'Принять запрос' : 'Принять посла'}
                  </button>
                )}
                {a.role === 'king' && a.status === 'accepted' && (
                  <>
                    {a.canReview && <a className="btn small" href={'#/council/' + a.ideaNumber}>Вынести на рассмотрение</a>}
                    {a.canDecide && <a className="btn primary small" href={'#/items/' + a.ideaNumber + '?audience=decide'}>Внедрить — оформить решение</a>}
                    {a.canConvene && <a className="btn small" href={'#/meetings/new?idea=' + a.ideaNumber + '&title=' + encodeURIComponent('Совет: ' + a.title)}>Созвать Совет</a>}
                    {!a.canDecide && <span className="small muted">Внедрение оформляет назначенный ответственный за решение.</span>}
                  </>
                )}
                {a.role === 'sender' && a.status === 'accepted' && (
                  <button type="button" className="btn small" onClick={() => setPlaying(a)}>{business ? 'Показать подтверждение' : 'Посмотреть аудиенцию'}</button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
      {playing && <AudienceCutscene audience={playing} onClose={() => setPlaying(null)} />}
    </section>
  );
}

/** A short, original animation rendered in-browser: no video of real people, no faces. */
export function AudienceCutscene({ audience, onClose }: { audience: Audience; onClose: () => void }) {
  const [lite] = useLite();
  const [ready, setReady] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), lite ? 0 : 5700);
    return () => window.clearTimeout(id);
  }, [lite]);
  return (
    <div className="audience-screen" role="dialog" aria-modal="true" aria-labelledby="audience-scene-heading" onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <div className={'audience-screen-inner' + (lite ? ' reduced' : '')}>
        <button type="button" ref={closeButton} className="btn small audience-close" onClick={onClose} aria-label="Закрыть сцену">✕ Закрыть</button>
        <div className="audience-cinematic" aria-hidden="true">
          <svg viewBox="0 0 960 470" preserveAspectRatio="xMidYMid meet">
            <defs>
              <linearGradient id="aud-bg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#0b1423"/><stop offset="1" stopColor="#253447"/>
              </linearGradient>
              <radialGradient id="aud-halo">
                <stop offset="0" stopColor="#d1a265" stopOpacity=".65"/>
                <stop offset="1" stopColor="#d1a265" stopOpacity="0"/>
              </radialGradient>
            </defs>
            <rect width="960" height="470" fill="url(#aud-bg)"/>
            <ellipse cx="535" cy="240" rx="310" ry="240" fill="url(#aud-halo)"/>
            <g fill="#182638" stroke="#967c58" strokeWidth="3">
              <rect x="85" y="52" width="112" height="310"/><rect x="762" y="52" width="112" height="310"/>
              <rect x="215" y="20" width="108" height="335"/><rect x="639" y="20" width="108" height="335"/>
              <path d="M323 90 Q481 -36 639 90V352H323Z" fill="#1e3040"/>
            </g>
            <g fill="#d3b781" opacity=".2"><path d="M392 86Q480 4 570 86L556 310H406Z"/></g>
            <path d="M0 379L960 379V470H0Z" fill="#111923"/>
            <path d="M480 385L260 470M480 385L700 470" stroke="#b29564" strokeWidth="3" opacity=".42"/>
            <g transform="translate(480 310)">
              <path d="M-105 73V-38H105V73Z" fill="#5f4333" stroke="#d6ad70" strokeWidth="5"/>
              <path d="M-104 -38L-72 -88L-40 -49L0 -100L40 -49L72 -88L104 -38Z" fill="#b9965b"/>
              <rect x="-68" y="-20" width="136" height="90" fill="#293449"/>
            </g>
            <g className="audience-king-figure" fill="#070d15">
              <circle cx="480" cy="252" r="19"/>
              <path d="M450 274L510 274L534 362H424Z"/>
              <path d="M456 239L464 216L478 231L490 216L506 239Z" fill="#d8b571" />
              <path className="audience-king-greeting" d="M515 293L555 264" stroke="#0b111b" strokeWidth="17" strokeLinecap="round"/>
            </g>
            <g className="audience-envoy-figure" fill="#050a11">
              <circle cx="0" cy="-66" r="17"/>
              <path d="M-24 -43H23L37 49H-42Z"/>
              <path d="M-20 40L-25 94M16 40L21 94" stroke="#050a11" strokeWidth="17" strokeLinecap="round"/>
              <path d="M35 -31L63 -9L49 0L27 -17Z"/>
              <path d="M49 -7L67 -17L80 6L61 15Z" fill="#c5a56b"/>
            </g>
            <path d="M110 393H850" stroke="#9a815d" opacity=".3"/>
          </svg>
        </div>
        <div className="audience-cutscene-copy">
          <span className="audience-eyebrow">ВЕСТИ ИЗ ВЕЛИКОГО СОДРУЖЕСТВА</span>
          <h2 id="audience-scene-heading">Король принял вашего посла</h2>
          <p>Обращение №{audience.ideaNumber} передано на аудиенцию. Это подтверждение приёма, не обещание внедрения.</p>
          <div className="row audience-actions">
            <a className="btn primary" href={'#/items/' + audience.ideaNumber} onClick={onClose}>
              Открыть обращение
            </a>
            <button type="button" className="btn" onClick={onClose}>{ready ? 'Продолжить' : 'Пропустить сцену'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
