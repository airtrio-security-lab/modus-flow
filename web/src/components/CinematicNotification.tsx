import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useLite } from '../lib/lite';
import { useSession } from '../lib/session';
import type { NotePreferences } from '../lib/types';
import {
  continuesBatch,
  deviceSince,
  modeFor,
  outcomeOf,
  parseLedger,
  parseSettings,
  plan,
  remember,
  soundFor,
  type Action,
  type Cue,
  type DeviceSince,
  type Mode,
  type Settings,
} from '../lib/cinematics';

/**
 * Cinematic notifications (ADR-0037). `CinematicHost` lives in the app shell, reads the reader's own
 * notifications and audiences that the session already polls, and shows at most a few scenes in a
 * row; `CinematicNotification` plays one of them. Watching, skipping or postponing changes nothing
 * on the server: every business action stays on its own screen behind its own permission check.
 */

// ---------------------------------------------------------------------------
// Device settings: «Кинематографические уведомления» and their sound.
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'modus.cine';
const listeners = new Set<(s: Settings) => void>();
const readSettings = (): Settings => {
  try {
    return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return parseSettings(null);
  }
};
export function useCinemaSettings(): [Settings, (s: Settings) => void] {
  const [v, setV] = useState<Settings>(readSettings);
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  const set = useCallback((next: Settings) => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* kept for this page only */
    }
    listeners.forEach((l) => l(next));
  }, []);
  return [v, set];
}

export function CinemaToggles() {
  const [s, set] = useCinemaSettings();
  return (
    <>
      <button type="button" className="btn small quiet" aria-pressed={s.enabled} onClick={() => set({ ...s, enabled: !s.enabled })}>
        {s.enabled ? 'Кинематографические уведомления: вкл' : 'Кинематографические уведомления: выкл'}
      </button>
      <button type="button" className="btn small quiet" aria-pressed={s.sound} disabled={!s.enabled} onClick={() => set({ ...s, sound: !s.sound })}>
        {s.sound ? 'Звук в сценах: вкл' : 'Звук в сценах: выкл'}
      </button>
    </>
  );
}

function useReducedMotion() {
  const q = () => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return null;
    }
  };
  const [v, setV] = useState(() => q()?.matches ?? false);
  useEffect(() => {
    const m = q();
    if (!m) return;
    const on = () => setV(m.matches);
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return v;
}

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: the batch still plays once in this page */
  }
};

// ---------------------------------------------------------------------------
// The host.
// ---------------------------------------------------------------------------
export function CinematicHost() {
  const s = useSession();
  const [lite] = useLite();
  const reducedMotion = useReducedMotion();
  const [settings] = useCinemaSettings();
  const [prefs, setPrefs] = useState<NotePreferences | null>(null);
  const [queue, setQueue] = useState<Cue[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const ledgerKey = `modus.cine.seen.${s.org}.${s.membershipId}`;
  const deviceKey = `modus.cine.device.${s.org}`;

  // Game or business wording and the chosen form of address: the person's own settings (ADR-0016).
  useEffect(() => {
    let live = true;
    const load = () =>
      api<NotePreferences>(`/orgs/${s.org}/me/notification-preferences`)
        .then((p) => live && setPrefs(p))
        .catch(() => undefined);
    void load();
    window.addEventListener('modus:note-prefs', load);
    return () => {
      live = false;
      window.removeEventListener('modus:note-prefs', load);
    };
  }, [s.org]);

  useEffect(() => {
    const feed = s.feed;
    if (!feed || !prefs || queueRef.current.length) return;
    const now = Date.now();
    let prev: DeviceSince | null = null;
    try {
      prev = JSON.parse(read(deviceKey) ?? 'null') as DeviceSince | null;
    } catch {
      prev = null;
    }
    const dev = deviceSince(prev, s.membershipId, s.directory ? s.directory.members.map((m) => m.membershipId) : null, now);
    if (!dev) return;
    if (dev !== prev) write(deviceKey, JSON.stringify(dev));
    let ledger = parseLedger(read(ledgerKey));
    const { show, batched } = plan({
      notes: feed.notes,
      audiences: feed.audiencesOk ? feed.audiences : [],
      membershipId: s.membershipId,
      currentKing: feed.king,
      ledger,
      since: dev.since,
      now,
      style: prefs.style,
    });
    // A mark for scripted runs and diagnostics: the decision for this refresh is made.
    const decided = () => (document.documentElement.dataset.cineChecked = '1');
    if (!show.length && !batched.length) {
      decided();
      return;
    }
    // Written down before anything plays: a reload, a crash or a second tab never shows it again.
    // Switched off: the facts are only written down, so switching on later does not replay them.
    for (const c of show) ledger = remember(ledger, c.key, settings.enabled ? 'shown' : 'batched');
    for (const c of batched) ledger = remember(ledger, c.key, 'batched');
    write(ledgerKey, JSON.stringify(ledger));
    if (settings.enabled) setQueue(show);
    decided();
  }, [s.feed, s.directory, s.membershipId, prefs, settings.enabled, ledgerKey, deviceKey]);

  const done = useCallback(
    (cue: Cue, action: Action, ended: boolean) => {
      let ledger = remember(parseLedger(read(ledgerKey)), cue.key, outcomeOf(action, ended));
      const rest = queueRef.current.slice(1);
      if (!continuesBatch(action)) for (const c of rest) ledger = remember(ledger, c.key, 'batched');
      write(ledgerKey, JSON.stringify(ledger));
      // The inbox has its own drawn scene of an accepted envoy: it must not tell the same fact again.
      if (cue.audienceId && cue.key.endsWith(':accepted')) {
        try {
          sessionStorage.setItem(`modus.audience.seen:${s.org}:${s.membershipId}:${cue.audienceId}`, '1');
        } catch {
          /* private mode */
        }
        void s.refreshInbox();
      }
      setQueue(continuesBatch(action) ? rest : []);
      if (action === 'now' || action === 'open') location.hash = cue.href;
    },
    [ledgerKey, s],
  );

  const cue = queue[0];
  if (!cue) return null;
  const env = { settings, lite, reducedMotion };
  const mode = modeFor(cue, env);
  if (mode === 'off') return null;
  const next = queue[1] ?? null;
  return (
    <>
      <CinematicNotification
        key={cue.key}
        cue={cue}
        mode={mode}
        sound={cue.scene ? soundFor(cue.scene, { settings, addressForm: prefs?.addressForm ?? null }) : false}
        voiceAllowed={!cue.scene?.address || prefs?.addressForm === cue.scene.address}
        next={next}
        remaining={queue.length - 1}
        onDone={(action, ended) => done(cue, action, ended)}
      />
      {next?.scene && modeFor(next, env) === 'video' ? <Preload src={next.scene.src} /> : null}
    </>
  );
}

/** Only the next scene is fetched ahead, and released as soon as it is not needed. */
function Preload({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    return () => {
      if (!v) return;
      v.removeAttribute('src');
      v.load();
    };
  }, []);
  return <video ref={ref} className="cine-preload" src={src} preload="auto" muted playsInline aria-hidden="true" tabIndex={-1} />;
}

// ---------------------------------------------------------------------------
// One scene.
// ---------------------------------------------------------------------------
type Phase = 'loading' | 'playing' | 'tap' | 'ended' | 'failed';
/** No picture within this time: the ordinary text notice instead. */
const LOAD_TIMEOUT_MS = 6000;

export function CinematicNotification({
  cue,
  mode,
  sound,
  voiceAllowed,
  next,
  remaining,
  onDone,
}: {
  cue: Cue;
  mode: Exclude<Mode, 'off'>;
  sound: boolean;
  /** False when the voice addresses the reader in a form they did not choose. */
  voiceAllowed: boolean;
  next: Cue | null;
  remaining: number;
  onDone: (action: Action, ended: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>(mode === 'video' ? 'loading' : 'ended');
  const [muted, setMuted] = useState(!sound);
  /** The browser refused sound without a gesture: it plays silently with «Включить звук». */
  const [blocked, setBlocked] = useState(false);
  const closed = useRef(false);
  const prompt = cue.scene?.kind === 'prompt';
  const failed = phase === 'failed';
  const ended = phase === 'ended' || failed;
  const titleId = `cine-title-${cue.key.replace(/[^a-z0-9]/gi, '')}`;

  const finish = useCallback(
    (action: Action) => {
      if (closed.current) return;
      closed.current = true;
      // A scene that could not be shown is written down as such, whatever closed it.
      onDone(phase === 'failed' && (action === 'close' || action === 'skip') ? 'failed' : action, phase === 'ended' || mode !== 'video');
    },
    [onDone, phase, mode],
  );

  // A modal dialog for a scene; a plain, non-blocking notice when there is no scene. Opened once per
  // scene; the handlers always call the current `finish`.
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const d = dialog.current;
    if (!d || mode === 'text') return;
    if (!d.open) d.showModal?.();
    const cancel = (e: Event) => {
      e.preventDefault();
      finishRef.current(prompt ? 'later' : 'skip');
    };
    // Chrome may close a dialog on a repeated Esc without asking: treat it as the same choice.
    const closedByBrowser = () => finishRef.current(prompt ? 'later' : 'skip');
    d.addEventListener('cancel', cancel);
    d.addEventListener('close', closedByBrowser);
    return () => {
      d.removeEventListener('cancel', cancel);
      d.removeEventListener('close', closedByBrowser);
      // Closing (not just removing) returns focus to where the person was.
      if (d.open) d.close();
    };
  }, [mode, prompt]);

  useEffect(() => {
    const v = video.current;
    if (mode !== 'video' || !v) return;
    let live = true;
    const fail = () => live && setPhase('failed');
    const timer = window.setTimeout(fail, LOAD_TIMEOUT_MS);
    const playing = () => {
      window.clearTimeout(timer);
      if (live) setPhase((p) => (p === 'ended' ? p : 'playing'));
    };
    const end = () => live && setPhase('ended');
    v.addEventListener('playing', playing);
    v.addEventListener('ended', end);
    v.addEventListener('error', fail);
    v.muted = !sound;
    v.play().catch(async (e: unknown) => {
      if (!live) return;
      if ((e as { name?: string })?.name === 'NotAllowedError' && !v.muted) {
        // Sound needs a gesture in this browser: play silently and offer the voice.
        v.muted = true;
        setMuted(true);
        setBlocked(true);
        try {
          await v.play();
        } catch {
          window.clearTimeout(timer);
          if (live) setPhase('tap');
        }
      } else if ((e as { name?: string })?.name === 'NotAllowedError') {
        window.clearTimeout(timer);
        setPhase('tap');
      } else if ((e as { name?: string })?.name !== 'AbortError') {
        fail();
      }
    });
    return () => {
      live = false;
      window.clearTimeout(timer);
      v.removeEventListener('playing', playing);
      v.removeEventListener('ended', end);
      v.removeEventListener('error', fail);
      // Release the decoder and the buffered video.
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
    // Started once per scene; the sound switch below acts on the element directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(() => {
    if (ended) primary.current?.focus();
  }, [ended]);

  const toggleSound = () => {
    const v = video.current;
    if (!v) return;
    const next = !muted;
    v.muted = next;
    setMuted(next);
    if (!next) {
      setBlocked(false);
      if (v.paused && !v.ended) void v.play().catch(() => undefined);
    }
  };
  const tapToPlay = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !voiceAllowed;
    setMuted(!voiceAllowed);
    v.play()
      .then(() => setPhase('playing'))
      .catch(() => setPhase('failed'));
  };

  const actions = (
    <div className="cine-actions">
      {prompt ? (
        <>
          <button type="button" ref={primary} className="btn primary" onClick={() => finish('now')}>
            Сейчас
          </button>
          <button type="button" className="btn" onClick={() => finish('later')}>
            Позже
          </button>
        </>
      ) : ended ? (
        <>
          <button type="button" ref={primary} className="btn primary" onClick={() => finish('open')}>
            {cue.linkLabel}
          </button>
          {next ? (
            <button type="button" className="btn" onClick={() => finish('next')}>
              Дальше: {next.title}
              {remaining > 1 ? ` (ещё ${remaining})` : ''}
            </button>
          ) : null}
          <button type="button" className="btn quiet" onClick={() => finish('close')}>
            Закрыть
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn" autoFocus onClick={() => finish('skip')}>
            Пропустить
          </button>
          <button type="button" className="btn quiet" onClick={() => finish('open')}>
            {cue.linkLabel}
          </button>
        </>
      )}
      {mode === 'video' && !failed && voiceAllowed ? (
        <button type="button" className={`btn quiet cine-sound${blocked ? ' is-blocked' : ''}`} aria-pressed={!muted} onClick={toggleSound}>
          {blocked ? 'Включить звук' : muted ? 'Звук: выкл' : 'Звук: вкл'}
        </button>
      ) : null}
    </div>
  );

  const copy = (
    <div className="cine-copy">
      <span className="cine-eyebrow">Королевские послания</span>
      <h2 id={titleId}>{cue.title}</h2>
      <p>{cue.text}</p>
      {failed ? (
        <p className="cine-note" role="status">
          Сцену не удалось показать — вот само уведомление.
        </p>
      ) : null}
      {mode === 'video' && !failed && !voiceAllowed ? <p className="cine-note">Сцена без голоса: в ней звучит обращение «Милорд», а вы выбрали другое.</p> : null}
      {actions}
    </div>
  );

  // No scene for this fact (or its video failed outside a dialog): an ordinary notice.
  if (mode === 'text')
    return (
      <section className="cine-text" role="status" aria-live="polite" aria-labelledby={titleId}>
        {copy}
      </section>
    );

  return (
    <dialog ref={dialog} className="cine" data-mode={failed ? 'failed' : mode} aria-labelledby={titleId}>
      <div className="cine-body">
        {!failed && cue.scene ? (
          <div className="cine-frame">
            {mode === 'video' ? (
              <video
                ref={video}
                className="cine-media"
                src={cue.scene.src}
                poster={cue.scene.poster}
                preload="auto"
                playsInline
                aria-hidden="true"
                tabIndex={-1}
                disablePictureInPicture
                controls={false}
              />
            ) : (
              <img className="cine-media" src={cue.scene.poster} alt="" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).hidden = true)} />
            )}
            {phase === 'tap' ? (
              <button type="button" className="btn primary cine-tap" onClick={tapToPlay}>
                Смотреть сцену
              </button>
            ) : null}
          </div>
        ) : null}
        {copy}
      </div>
    </dialog>
  );
}
