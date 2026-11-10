import { useEffect, useState } from 'react';

/**
 * «Облегчённая графика»: no animations, no texture filters, fewer map details.
 * On by default when the system asks for reduced motion or the device looks
 * slow (≤ 4 CPU threads or ≤ 4 GB memory); the person can switch it either way
 * and the choice is kept on this device.
 */
const KEY = 'modus.lite';

function auto(): boolean {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    const n = navigator as Navigator & { deviceMemory?: number };
    return (n.hardwareConcurrency ?? 8) <= 4 || (n.deviceMemory ?? 8) <= 4;
  } catch {
    return false;
  }
}

function read(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* storage unavailable */
  }
  return auto();
}

const listeners = new Set<(v: boolean) => void>();
let current: boolean | null = null;

export function initLite() {
  current = read();
  document.documentElement.dataset.lite = current ? 'on' : 'off';
}

export function useLite(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState<boolean>(() => current ?? read());
  useEffect(() => {
    listeners.add(setV);
    return () => void listeners.delete(setV);
  }, []);
  const set = (next: boolean) => {
    current = next;
    try {
      localStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      /* kept for this page only */
    }
    document.documentElement.dataset.lite = next ? 'on' : 'off';
    listeners.forEach((l) => l(next));
  };
  return [v, set];
}

export function LiteToggle() {
  const [lite, setLite] = useLite();
  return (
    <button type="button" className="btn small quiet" aria-pressed={lite} onClick={() => setLite(!lite)}>
      {lite ? 'Облегчённая графика: вкл' : 'Облегчённая графика: выкл'}
    </button>
  );
}
