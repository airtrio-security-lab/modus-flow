import { useEffect, useState } from 'react';

/**
 * State that survives going to an item and back (filters, chosen tab) for this
 * browser tab only. Falls back to plain state when storage is unavailable.
 */
export function useRemembered<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(`modus.ui.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`modus.ui.${key}`, JSON.stringify(v));
    } catch {
      /* not remembered */
    }
  }, [key, v]);
  return [v, setV];
}
