/** One icon family: 24×24 grid, 1.75 stroke, round joins. Decorative next to text (aria-hidden). */
export type IconName = 'inbox-stack' | 'briefcase' | 'columns' | 'bell' | 'chart' | 'plus' | 'castle' | 'table' | 'trophy' | 'person';
const PATHS: Record<IconName, string> = {
  table: 'M12 9.5a6 2.5 0 1 0 0.01 0M6 12v3M18 12v3M12 14.5V18M5 7l1.5 1.5M19 7l-1.5 1.5M12 4v2.5',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4v3h-4z',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  castle: 'M4 20V9h2.5v2h2V9h2v2h3V9h2v2h2V9H20v11zM10 20v-3.5a2 2 0 0 1 4 0V20M12 4.5V9M12 4.5l3 1-3 1',
  'inbox-stack': 'M4 13h4l1.5 2.5h5L16 13h4M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z',
  briefcase: 'M4 8h16v11H4zM9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8M4 13h16',
  columns: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  chart: 'M4 20h16M7 16v-5M12 16V7M17 16v-8',
  plus: 'M12 5v14M5 12h14',
};
export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
