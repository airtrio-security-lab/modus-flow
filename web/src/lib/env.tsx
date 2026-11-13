import { useEffect, useState } from 'react';

/** Online / offline (PWA): shown as a banner, never as a silent failure. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

type Theme = 'system' | 'light' | 'dark';
const KEY = 'modus.theme';
const LABEL: Record<Theme, string> = { system: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

function apply(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
export function initTheme() {
  try {
    const t = localStorage.getItem(KEY) as Theme | null;
    if (t === 'light' || t === 'dark') apply(t);
    else if (!t) apply('dark');
  } catch {
    /* storage unavailable: follow the system */
  }
}

/** Per-viewer convenience: system / light / dark, remembered on this device. */
export function ThemeToggle() {
  const [t, setT] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme | null) ?? 'dark';
    } catch {
      return 'system';
    }
  });
  return (
    <button
      type="button"
      className="btn quiet small theme-toggle"
      onClick={() => {
        const n = NEXT[t];
        setT(n);
        apply(n);
        try {
          localStorage.setItem(KEY, n);
        } catch {
          /* not remembered; still applied for this visit */
        }
      }}
    >
      {LABEL[t]}
    </button>
  );
}
