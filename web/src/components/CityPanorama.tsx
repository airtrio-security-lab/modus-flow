import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { District } from '../lib/types';
import './city-panorama.css';

/** Landmarks overlay original Camelot and Russian Tsardom artwork.
 * Every click uses existing, server-authorized routes, never a simulated business outcome.
 */
export const CAMELOT_BUILDINGS = [
  { id: 'library', name: 'Великая библиотека', detail: 'Наследие отдела', x: 19, y: 29, tab: 'legacy' },
  { id: 'council', name: 'Зал Совета', detail: 'Мнения, заседания, решения', x: 51, y: 31, tab: 'council' },
  { id: 'archive', name: 'Высший Архив', detail: 'Проверенные знания', x: 85, y: 29, tab: 'archive' },
  { id: 'warriors', name: 'Зал воинов', detail: 'Мысли, заметки, предложения', x: 30, y: 52, tab: 'warriors' },
  { id: 'staff', name: 'Гильдия', detail: 'Состав и специалисты', x: 78, y: 49, tab: 'staff' },
  { id: 'tasks', name: 'Мастерские', detail: 'Задачи и внедрение', x: 87, y: 62, tab: 'tasks' },
  { id: 'initiatives', name: 'Площадь инициатив', detail: 'Идеи и предложения', x: 50, y: 62, tab: 'initiatives' },
  { id: 'growth', name: 'Цитадель', detail: 'Уровень, опыт и достижения', x: 51, y: 15, tab: 'growth' },
] as const;

export const RUSSIAN_BUILDINGS = [
  { id: 'growth', name: 'Московский Кремль', detail: 'Уровень, опыт и развитие', x: 50, y: 29, tab: 'growth' },
  { id: 'archive', name: 'Государев Архив', detail: 'Проверенные знания', x: 64, y: 32, tab: 'archive' },
  { id: 'council', name: 'Боярская дума', detail: 'Обсуждения и решения', x: 82, y: 55, tab: 'council' },
  { id: 'library', name: 'Книжные палаты', detail: 'Наследие и история', x: 19, y: 58, tab: 'legacy' },
  { id: 'warriors', name: 'Воинская палата', detail: 'Личные мысли и предложения', x: 43, y: 68, tab: 'warriors' },
  { id: 'staff', name: 'Приказная палата', detail: 'Сотрудники и специалисты', x: 80, y: 62, tab: 'staff' },
  { id: 'tasks', name: 'Ремесленный двор', detail: 'Задачи и внедрения', x: 26, y: 68, tab: 'tasks' },
  { id: 'initiatives', name: 'Торговая площадь', detail: 'Идеи и инициативы', x: 50, y: 55, tab: 'initiatives' },
] as const;

/** The push is shorter than a blink of impatience: the section opens after this many milliseconds. */
const PUSH_MS = 330;

export function CivilizationPanorama({ district, onPickStyle }: { district: District; onPickStyle: () => void }) {
  const [active, setActive] = useState<string | null>(null);
  const isRussia = district.civilization.id === 'russia';
  const cityName = isRussia ? 'Русское царство' : 'Камелот';
  // Genitive for «все здания …».
  const cityOf = isRussia ? 'Русского царства' : 'Камелота';
  const buildings = isRussia ? RUSSIAN_BUILDINGS : CAMELOT_BUILDINGS;
  const cityImage = isRussia ? '/media/russian-tsardom-city.svg' : '/media/camelot-city.webp';
  const imageAlt = isRussia
    ? 'Панорама Москвы XVII века: Московский Кремль, белокаменные соборы, боярские палаты, торг и деревянные мастерские'
    : 'Кинематографичная панорама Камелота: крепость, библиотека, зал Совета, арена, мастерские и площади';
  const routeFor = (tab: string) =>
    tab === 'archive' ? '#/library?hall=archive' : '#/castles/' + district.id + '/' + tab;
  // A short push of the picture towards the clicked building before its section opens (taken from PR #16,
  // for both towns). Decoration only: the link is an ordinary link, a second click or Escape opens the
  // section at once, a modified click (new tab) is left to the browser, and with reduced motion or the
  // lite graphics there is no push at all.
  const [entering, setEntering] = useState<{ x: number; y: number; href: string } | null>(null);
  const pushTimer = useRef<number | null>(null);
  // Where the push leads: kept outside the render, so Escape works from the very first moment.
  const pending = useRef<string | null>(null);
  const finish = () => {
    const href = pending.current;
    if (pushTimer.current !== null) window.clearTimeout(pushTimer.current);
    pushTimer.current = null;
    pending.current = null;
    if (href) window.location.hash = href;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pending.current) finish();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pushTimer.current !== null) window.clearTimeout(pushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const enter = (e: ReactMouseEvent<HTMLAnchorElement>, b: { x: number; y: number; tab: string }) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    let still = document.documentElement.dataset.lite === 'on';
    try {
      still = still || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* no matchMedia: the link works as a link */
    }
    if (still) return;
    e.preventDefault();
    const href = routeFor(b.tab);
    if (pending.current) {
      finish();
      return;
    }
    pending.current = href;
    setEntering({ x: b.x, y: b.y, href });
    pushTimer.current = window.setTimeout(finish, PUSH_MS);
  };
  return (
    <section className="town-section" aria-label={'Интерактивный город ' + cityName + ' — ' + district.name}>
      <header className="town-heading">
        <div>
          <span className="town-overline">MODUS FLOW · Живой город</span>
          <h1>{district.name} <span>· {cityName}</span></h1>
          <p>Выберите здание, чтобы войти в рабочий раздел. Город — навигация, а не отдельная система полномочий.</p>
        </div>
        <div className="town-heading-actions">
          <span className="town-level">Уровень {district.level} · {district.levelName}</span>
          {district.canChooseCivilization ? (
            <button type="button" className="btn small quiet" onClick={onPickStyle}>Сменить стиль</button>
          ) : null}
        </div>
      </header>
      <div className="town-scroll" tabIndex={0} aria-label="Панорама города: прокрутите по горизонтали на узком экране">
        <div
          className={entering ? 'town-canvas is-entering' : 'town-canvas'}
          aria-busy={entering ? true : undefined}
          style={entering ? ({ '--enter-x': entering.x + '%', '--enter-y': entering.y + '%' } as CSSProperties) : undefined}
        >
          <img
            src={cityImage}
            alt={imageAlt}
            width={1448}
            height={1086}
            loading="eager"
            decoding="async"
          />
          <div className="town-atmosphere" aria-hidden="true">
            <span className="town-atmo-cloud town-atmo-cloud-a" />
            <span className="town-atmo-cloud town-atmo-cloud-b" />
            <span className="town-atmo-haze" />
            <span className="town-atmo-smoke town-atmo-smoke-a" />
            <span className="town-atmo-smoke town-atmo-smoke-b" />
            <span className="town-atmo-birds town-atmo-birds-a" />
            <span className="town-atmo-birds town-atmo-birds-b" />
            <span className="town-atmo-light town-atmo-light-a" />
            <span className="town-atmo-light town-atmo-light-b" />
            <span className="town-atmo-light town-atmo-light-c" />
          </div>
          <div className="town-hotspots">
            {buildings.map((b) => (
              <a
                key={b.id}
                className={'town-hotspot' + (active === b.id ? ' is-active' : '')}
                style={{ left: b.x + '%', top: b.y + '%' }}
                href={routeFor(b.tab)}
                onClick={(e) => enter(e, b)}
                onFocus={() => setActive(b.id)}
                onBlur={() => setActive(null)}
                onMouseEnter={() => setActive(b.id)}
                onMouseLeave={() => setActive(null)}
                aria-label={b.name + ': ' + b.detail}
                title={b.name + ' — ' + b.detail}
              >
                <span className="town-hotspot-dot" aria-hidden="true">✦</span>
                <span className="town-hotspot-info"><strong>{b.name}</strong><small>{b.detail}</small></span>
              </a>
            ))}
          </div>
        </div>
      </div>
      <nav className="town-shortcuts" aria-label={'Все здания ' + cityOf}>
        {buildings.map((b) => (
          <a key={b.id} href={routeFor(b.tab)}
            onFocus={() => setActive(b.id)} onBlur={() => setActive(null)}
            onMouseEnter={() => setActive(b.id)} onMouseLeave={() => setActive(null)}
            className={active === b.id ? 'is-active' : undefined}>
            <strong>{b.name}</strong><small>{b.detail}</small>
          </a>
        ))}
      </nav>
      <p className="small muted town-instruction">На телефоне двигайте панораму пальцем или воспользуйтесь списком зданий. Все разделы также доступны через обычные вкладки.</p>
    </section>
  );
}
