import { CAMELOT_BUILDINGS, RUSSIAN_BUILDINGS } from './CityPanorama';
import type { District } from '../lib/types';

/**
 * The buildings of a district's town (ADR-0029): the same eight working sections in the painted
 * panorama and in the 3D town. A building is navigation only: the link leads to an ordinary,
 * server-authorized section, and the same sections stay in the tabs.
 */
export interface TownBuilding {
  id: string;
  name: string;
  detail: string;
  href: string;
}

const NEUTRAL = [
  { id: 'growth', name: 'Цитадель', detail: 'Уровень, опыт и развитие', tab: 'growth' },
  { id: 'council', name: 'Зал совета', detail: 'Обсуждения и решения', tab: 'council' },
  { id: 'archive', name: 'Архив знаний', detail: 'Проверенные знания', tab: 'archive' },
  { id: 'library', name: 'Наследие', detail: 'История отдела', tab: 'legacy' },
  { id: 'warriors', name: 'Зал воинов', detail: 'Мысли и предложения', tab: 'warriors' },
  { id: 'staff', name: 'Состав', detail: 'Сотрудники и специалисты', tab: 'staff' },
  { id: 'tasks', name: 'Мастерские', detail: 'Задачи и внедрение', tab: 'tasks' },
  { id: 'initiatives', name: 'Площадь инициатив', detail: 'Идеи и предложения', tab: 'initiatives' },
] as const;

export const hasPanorama = (civ: string) => civ === 'camelot' || civ === 'russia';

export function townBuildings(d: Pick<District, 'id' | 'civilization'>): TownBuilding[] {
  const list = d.civilization.id === 'russia' ? RUSSIAN_BUILDINGS : d.civilization.id === 'camelot' ? CAMELOT_BUILDINGS : NEUTRAL;
  return list.map((b) => ({
    id: b.id,
    // Other civilizations have no painted town yet: the council hall carries the name the server gives it.
    name: list === NEUTRAL && b.id === 'council' ? d.civilization.hall : b.name,
    detail: b.detail,
    href: b.tab === 'archive' ? '#/library?hall=archive' : `#/castles/${d.id}/${b.tab}`,
  }));
}
