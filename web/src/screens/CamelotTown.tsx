import { useState, type CSSProperties } from 'react';
import './camelot-town.css';

type Building = {
  id: string;
  label: string;
  detail: string;
  x: number;
  y: number;
  href: (districtId: string) => string;
};

const BUILDINGS: readonly Building[] = [
  { id: 'library', label: 'Великая библиотека', detail: 'Наследие отдела', x: 19, y: 29, href: (id) => '#/castles/' + id + '/legacy' },
  { id: 'council', label: 'Зал Совета', detail: 'Мнения, заседания, решения', x: 51, y: 31, href: (id) => '#/castles/' + id + '/council' },
  { id: 'archive', label: 'Высший Архив', detail: 'Проверенные знания', x: 85, y: 29, href: () => '#/library?hall=archive' },
  { id: 'warriors', label: 'Зал воинов', detail: 'Мысли, заметки, предложения', x: 30, y: 52, href: (id) => '#/castles/' + id + '/warriors' },
  { id: 'guild', label: 'Гильдия', detail: 'Состав и специалисты', x: 78, y: 49, href: (id) => '#/castles/' + id + '/staff' },
  { id: 'workshop', label: 'Мастерские', detail: 'Задачи и внедрение', x: 87, y: 62, href: (id) => '#/castles/' + id + '/tasks' },
  { id: 'square', label: 'Площадь инициатив', detail: 'Идеи и предложения', x: 50, y: 62, href: (id) => '#/castles/' + id + '/initiatives' },
  { id: 'citadel', label: 'Цитадель', detail: 'Уровень, опыт и достижения', x: 51, y: 15, href: (id) => '#/castles/' + id + '/growth' },
];

function FallbackBuilding({ x, y, w, h, blue = false }: {
  x: number; y: number; w: number; h: number; blue?: boolean;
}) {
  const roof = blue ? '#294764' : '#546477';
  return (
    <g>
      <rect x={x - 14} y={y + h - 7} width={w + 28} height="26" rx="3" fill="#43423f" opacity=".5" />
      <rect x={x} y={y} width={w} height={h} fill="url(#camelot-stone)" stroke="#806c50" strokeWidth="5" />
      <path d={'M' + (x - 16) + ' ' + y + ' L' + (x + w / 2) + ' ' + (y - h * .32) + ' L' + (x + w + 16) + ' ' + y + 'Z'} fill={roof} stroke="#caaf74" strokeWidth="6" />
      {Array.from({ length: 4 }, (_, i) => (
        <g key={i}>
          <rect x={x + (i + 1) * w / 5 - 10} y={y + h * .23} width="20" height={h * .33} rx="8" fill="#283747" stroke="#bca879" strokeWidth="4" />
          <path d={'M' + (x + (i + 1) * w / 5 - 10) + ' ' + (y + h * .52) + ' h20'} stroke="#d7b96c" strokeWidth="3" />
        </g>
      ))}
      <rect x={x + w / 2 - 23} y={y + h * .62} width="46" height={h * .38} rx="22" fill="#1e2c35" stroke="#d0b680" strokeWidth="5" />
    </g>
  );
}

/** Self-contained art if the optional generated WebP has not yet been installed. */
function CamelotFallbackArt() {
  return (
    <svg className="camelot-town-fallback" viewBox="0 0 1448 1086" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="camelot-sky" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#5c6c82" /><stop offset=".54" stopColor="#b9bbad" /><stop offset="1" stopColor="#647a79" /></linearGradient>
        <linearGradient id="camelot-stone" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#e8dbb7" /><stop offset=".56" stopColor="#b4a58a" /><stop offset="1" stopColor="#7c807d" /></linearGradient>
        <linearGradient id="camelot-ground" x1="0" x2="0" y1="0" y2="1"><stop stopColor="#6d8074" /><stop offset="1" stopColor="#304e4c" /></linearGradient>
      </defs>
      <rect width="1448" height="1086" fill="url(#camelot-sky)" />
      <path d="M0 300 75 187 149 227 280 66 396 223 510 162 650 275 790 145 900 268 1050 114 1190 256 1335 134 1448 260V560H0Z" fill="#53677a" />
      <path d="M0 340 175 250 336 320 503 230 662 327 853 230 1040 330 1215 260 1448 320V625H0Z" fill="#7b8985" opacity=".74" />
      <path d="M0 510Q400 398 710 459T1448 440V1086H0Z" fill="url(#camelot-ground)" />
      <path d="M1448 460Q1335 620 1410 765T1310 1086H1448Z" fill="#467987" stroke="#b6c5b5" strokeWidth="10" />
      <path d="M0 730Q350 682 710 745T1448 731V795Q900 772 720 840T0 813Z" fill="#c4b69a" stroke="#8d7a65" strokeWidth="9" />
      <path d="M692 1086 648 785 701 490 759 490 794 785 790 1086Z" fill="#b5a487" opacity=".9" />
      <FallbackBuilding x={573} y={226} w={310} h={196} blue />
      <FallbackBuilding x={95} y={310} w={270} h={192} blue />
      <FallbackBuilding x={1082} y={314} w={230} h={195} />
      <FallbackBuilding x={220} y={518} w={255} h={155} blue />
      <FallbackBuilding x={981} y={529} w={250} h={160} blue />
      <FallbackBuilding x={568} y={116} w={310} h={140} />
      <g fill="#ac9b7d" stroke="#dac99e" strokeWidth="8">
        <circle cx="725" cy="685" r="142" />
        <circle cx="725" cy="685" r="105" fill="#8f9283" />
        <circle cx="725" cy="685" r="40" fill="#d3ad64" />
      </g>
      <path d="M12 805Q720 715 1434 805V914Q700 831 12 923Z" fill="#a49783" stroke="#5c574b" strokeWidth="15" />
      {Array.from({ length: 17 }, (_, i) => (
        <rect key={i} x={24 + i * 86} y={807 + Math.abs(i - 8) * 5} width="56" height="35" fill="#cab99b" stroke="#746d63" strokeWidth="5" />
      ))}
      <g stroke="#e2c684" strokeWidth="9" fill="none" opacity=".63"><path d="M12 805Q720 715 1434 805" /><path d="M650 925h150" /></g>
      <rect width="1448" height="1086" fill="#152b41" opacity=".07" />
    </svg>
  );
}

export function CamelotTown({ districtId, districtName, level, xp }: {
  districtId: string;
  districtName: string;
  level: number;
  xp: number;
}) {
  const [artUnavailable, setArtUnavailable] = useState(false);
  return (
    <section className="camelot-town" aria-labelledby="camelot-town-heading">
      <header className="camelot-town-header">
        <div className="camelot-town-kicker">ВЕЛИКОЕ СОДРУЖЕСТВО · КАМЕЛОТ</div>
        <h2 id="camelot-town-heading">{districtName}</h2>
        <p>Войдите в здание, чтобы открыть соответствующий рабочий раздел.</p>
        <div className="camelot-town-meta">
          <span>Уровень {level} из 5</span>
          <span>{xp} XP</span>
          <span>Все функции доступны с первого уровня</span>
        </div>
      </header>
      <p className="camelot-town-mobile-hint">Прокрутите панораму по горизонтали, чтобы исследовать город, или выберите здание из списка ниже.</p>
      <div className="camelot-town-viewport" tabIndex={0} aria-label="Город Камелот. На узком экране панораму можно прокручивать по горизонтали.">
        <div className="camelot-town-stage">
          {artUnavailable ? <CamelotFallbackArt /> : (
            <img className="camelot-town-art" src="/towns/camelot.webp" alt="" width={1448} height={1086} decoding="async" onError={() => setArtUnavailable(true)} />
          )}
          <div className="camelot-town-shadow" aria-hidden="true" />
          {BUILDINGS.map((b) => (
            <a key={b.id} href={b.href(districtId)} className={'camelot-town-hotspot camelot-' + b.id}
              style={{ '--x': b.x + '%', '--y': b.y + '%' } as CSSProperties} aria-label={b.label + ': ' + b.detail}>
              <span className="camelot-town-beacon" aria-hidden="true">✧</span>
              <span className="camelot-town-tooltip"><strong>{b.label}</strong><small>{b.detail}</small></span>
            </a>
          ))}
          <span className="camelot-town-overlay-title" aria-hidden="true">КАМЕЛОТ</span>
          <div className="camelot-town-level" aria-hidden="true">Владение · уровень {level}</div>
        </div>
      </div>
      <nav className="camelot-town-shortcuts" aria-label="Здания Камелота — быстрые переходы">
        {BUILDINGS.map((b) => (
          <a key={b.id} href={b.href(districtId)}>
            <span className="camelot-shortcut-symbol" aria-hidden="true">◆</span>
            <span><strong>{b.label}</strong><small>{b.detail}</small></span>
          </a>
        ))}
      </nav>
    </section>
  );
}
