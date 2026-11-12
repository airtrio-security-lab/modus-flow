import { useState } from 'react';
import type { District } from '../lib/types';
import './city-panorama.css';

/** Coordinates correspond to the licensed, original Camelot panorama at 1448×1086.
 * The image is presentation only; every click is a normal link into the existing,
 * server-authorization-checked module, with no simulated business success.
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

export function CamelotPanorama({ district, onPickStyle }: { district: District; onPickStyle: () => void }) {
  const [active, setActive] = useState<string | null>(null);
  const routeFor = (tab: string) =>
    tab === 'archive' ? '#/library?hall=archive' : '#/castles/' + district.id + '/' + tab;
  return (
    <section className="town-section" aria-label={'Интерактивный город Камелот — ' + district.name}>
      <header className="town-heading">
        <div>
          <span className="town-overline">MODUS FLOW · Живой город</span>
          <h1>{district.name} <span>· Камелот</span></h1>
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
        <div className="town-canvas">
          <img
            src="/media/camelot-city.webp"
            alt="Кинематографичная панорама Камелота: крепость, библиотека, зал Совета, арена, мастерские и площади"
            width={1448}
            height={1086}
            loading="eager"
            decoding="async"
          />
          <div className="town-hotspots">
            {CAMELOT_BUILDINGS.map((b) => (
              <a
                key={b.id}
                className={'town-hotspot' + (active === b.id ? ' is-active' : '')}
                style={{ left: b.x + '%', top: b.y + '%' }}
                href={routeFor(b.tab)}
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
      <nav className="town-shortcuts" aria-label="Все здания Камелота">
        {CAMELOT_BUILDINGS.map((b) => (
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
