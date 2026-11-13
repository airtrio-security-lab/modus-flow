import { useCallback, useEffect, useRef, useState } from 'react';
import './opening-intro.css';

/**
 * Заставка при открытии приложения: 9-секундный ролик (замок, ворота открываются).
 * Один раз на вкладку (перезагрузка не повторяет), всегда можно пропустить.
 * Не показывается при «облегчённой графике» / reduced motion (ролик даже не скачивается)
 * и в автоматических прогонах (navigator.webdriver), чтобы не мешать e2e-сценариям.
 * `localStorage['modus.intro']`: 'off' — выключить, 'force' — показывать при каждой загрузке.
 */
const SEEN_KEY = 'modus.intro.shown';
const SRC = '/cinematics/opening.mp4';
const POSTER = '/cinematics/opening.jpg';
const START_TIMEOUT_MS = 4000;
const HARD_CAP_MS = 14000;
const FADE_MS = 450;

function shouldShow(): boolean {
  try {
    // `modus.intro`: 'off' — never, 'force' — every load (scenarios and demo recording).
    const pref = localStorage.getItem('modus.intro');
    if (pref === 'off') return false;
    if (pref === 'force') return true;
    if (navigator.webdriver) return false;
    if (document.documentElement.dataset.lite === 'on') return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    if (sessionStorage.getItem(SEEN_KEY)) return false;
    // Written before playing: a reload or crash mid-intro does not replay it.
    sessionStorage.setItem(SEEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** Decided once per page load: StrictMode calls state initialisers twice, and the second call would see the mark. */
let decision: boolean | null = null;
function decideOnce(): boolean {
  decision ??= shouldShow();
  return decision;
}

export function OpeningIntro() {
  const [show] = useState(decideOnce);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  const [muted, setMuted] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const skipBtn = useRef<HTMLButtonElement>(null);

  const finish = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => setGone(true), FADE_MS);
  }, []);

  useEffect(() => {
    if (!show) return;
    const v = video.current;
    if (!v) return;
    let live = true;
    // The cleanup below drops the source; a re-run (StrictMode) has to give it back.
    if (!v.getAttribute('src')) v.src = SRC;
    const startTimer = window.setTimeout(() => live && finish(), START_TIMEOUT_MS);
    const capTimer = window.setTimeout(() => live && finish(), HARD_CAP_MS);
    const playing = () => window.clearTimeout(startTimer);
    const end = () => live && finish();
    v.addEventListener('playing', playing);
    v.addEventListener('ended', end);
    v.addEventListener('error', end);
    v.muted = false;
    v.play().catch(async (e: unknown) => {
      if (!live) return;
      // Sound without a gesture is refused by browsers: play silently, offer «Включить звук».
      if ((e as { name?: string })?.name === 'NotAllowedError') {
        v.muted = true;
        setMuted(true);
        try {
          await v.play();
        } catch {
          if (live) finish();
        }
      } else if ((e as { name?: string })?.name !== 'AbortError') {
        finish();
      }
    });
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish();
    };
    document.addEventListener('keydown', key);
    skipBtn.current?.focus();
    return () => {
      live = false;
      window.clearTimeout(startTimer);
      window.clearTimeout(capTimer);
      document.removeEventListener('keydown', key);
      v.removeEventListener('playing', playing);
      v.removeEventListener('ended', end);
      v.removeEventListener('error', end);
      // Release the decoder and the buffered video.
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [show, finish]);

  if (!show || gone) return null;

  const toggleSound = () => {
    const v = video.current;
    if (!v) return;
    v.muted = !muted;
    setMuted(!muted);
    if (v.paused && !v.ended) void v.play().catch(() => undefined);
  };

  return (
    <div className={`opening-intro${leaving ? ' is-leaving' : ''}`} role="dialog" aria-modal="true" aria-label="Заставка MODUS FLOW">
      <img className="opening-intro-backdrop" src="/cinematics/opening-backdrop.jpg" alt="" aria-hidden="true" />
      <video ref={video} className="opening-intro-video" src={SRC} poster={POSTER} playsInline preload="auto" aria-hidden="true" tabIndex={-1} />
      <div className="opening-intro-actions">
        <button type="button" className="btn quiet" aria-pressed={!muted} onClick={toggleSound}>
          {muted ? 'Включить звук' : 'Звук: вкл'}
        </button>
        <button type="button" ref={skipBtn} className="btn" onClick={finish}>
          Пропустить
        </button>
      </div>
    </div>
  );
}
