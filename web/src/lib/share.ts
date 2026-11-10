/**
 * Android share target: «Поделиться» → MODUS FLOW opens /share?text=…
 * (manifest share_target). main.tsx stashes the text and moves to #/new;
 * the form takes it once.
 */
const KEY = 'modus.shared';

export function captureShare(): boolean {
  if (location.pathname !== '/share') return false;
  const p = new URLSearchParams(location.search);
  const text = [p.get('title'), p.get('text'), p.get('url')].filter((x) => x && x.trim()).join('\n').trim();
  try {
    if (text) sessionStorage.setItem(KEY, text.slice(0, 5000));
  } catch {
    memory = text.slice(0, 5000);
  }
  history.replaceState(null, '', '/#/new');
  return true;
}
let memory: string | null = null;

export function takeShared(): string | null {
  let t: string | null = memory;
  memory = null;
  try {
    t = sessionStorage.getItem(KEY) ?? t;
    sessionStorage.removeItem(KEY);
  } catch {
    /* private mode: the in-memory copy is used */
  }
  return t;
}
