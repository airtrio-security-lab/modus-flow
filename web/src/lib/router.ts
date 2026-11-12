import { useEffect, useState } from 'react';

/** Hash routing: works from a static file server and in the installed PWA. */
export function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] ?? '').split('/').filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export const go = (path: string) => {
  location.hash = path.startsWith('#') ? path : `#${path}`;
};
