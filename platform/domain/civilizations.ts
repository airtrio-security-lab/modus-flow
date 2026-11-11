/**
 * Architectural styles of the city's districts (ADR-0019). A style is a picture only: every
 * civilization has the same five levels, the same XP rules and the same business abilities.
 * It is chosen by the department, never derived from who works there.
 * To add a style: a migration widens the CHECK on departments.civilization, the art goes to
 * web/src/components/civ.tsx, and the entry below.
 */
export const CIVILIZATIONS = [
  { id: 'europe', name: 'Средневековая Европа', motto: 'Каменные крепости, башни и стены' },
  { id: 'japan', name: 'Япония', motto: 'Многоярусные крыши, сады и мосты' },
  { id: 'mongolia', name: 'Монголия', motto: 'Степная ставка, юрты и знамёна' },
  { id: 'kazakh', name: 'Казахское ханство', motto: 'Ставка хана, караван-сарай и купола' },
] as const;
export type CivilizationId = (typeof CIVILIZATIONS)[number]['id'];
export const CIVILIZATION_IDS = CIVILIZATIONS.map((c) => c.id) as [CivilizationId, ...CivilizationId[]];
export const civilizationName = (id: string) => CIVILIZATIONS.find((c) => c.id === id)?.name ?? id;
