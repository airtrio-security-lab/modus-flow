import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { useSession } from '../lib/session';

export function ExperienceHero({ eyebrow, title, description, icon, art = 'city', children }: {
  eyebrow: string; title: string; description: string; icon: IconName; art?: 'city' | 'council'; children?: ReactNode;
}) {
  return <header className={`experience-hero experience-hero--${art}`}>
    <img className="experience-art" src={art === 'council' ? '/media/commonwealth-council.webp' : '/media/commonwealth-city.webp'} alt="" fetchPriority="high" />
    <div className="experience-copy">
      <span className="experience-eyebrow"><Icon name={icon} />{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children ? <div className="experience-actions">{children}</div> : null}
    </div>
    <span className="experience-seal" aria-hidden="true"><Icon name={icon} /></span>
  </header>;
}

export function MetricStrip({ items }: { items: { label: string; value: ReactNode; icon: IconName; tone?: string }[] }) {
  return <dl className="experience-metrics">{items.map(item => <div key={item.label} data-tone={item.tone}>
    <span className="metric-icon"><Icon name={item.icon} /></span>
    <dt>{item.label}</dt><dd>{item.value}</dd>
  </div>)}</dl>;
}

/** Secondary destinations stay available without replacing the five primary tabs. */
export function SectionMenu() {
  const s = useSession();
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = () => { if (ref.current) ref.current.open = false; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && ref.current?.open) { close(); ref.current.querySelector('summary')?.focus(); } };
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    window.addEventListener('hashchange', close);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('hashchange', close); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, []);
  const links: { href: string; label: string; icon: IconName }[] = [
    { href: '#/library', label: 'Великая библиотека', icon: 'library' },
    { href: '#/rating', label: 'Достижения Содружества', icon: 'trophy' },
    { href: '#/board', label: 'Доска обращений', icon: 'columns' },
    { href: '#/inbox', label: 'Уведомления', icon: 'bell' },
    ...(s.isLead || s.isAdmin ? [{ href: '#/overview', label: 'Обзор для руководства', icon: 'chart' as const }] : []),
    ...(s.isAdmin ? [{ href: '#/settings', label: 'Настройки', icon: 'settings' as const }] : []),
  ];
  return <details className="section-menu" ref={ref}>
    <summary aria-label="Все разделы"><Icon name="compass" /></summary>
    <nav aria-label="Все разделы"><span className="section-menu-title">Содружество</span>{links.map(link => <a href={link.href} key={link.href} onClick={() => { if (ref.current) ref.current.open = false; }}><Icon name={link.icon} />{link.label}<Icon name="arrow" /></a>)}</nav>
  </details>;
}
