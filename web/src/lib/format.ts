const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** «3 часа назад», «вчера», «12 ноября». */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const min = Math.round((now - t) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.round(h / 24);
  if (d === 1) return 'вчера';
  if (d < 7) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return dateFmt.format(new Date(iso));
}

/** Time left or overdue, for deadlines: «через 5 ч», «просрочено на 2 дня». */
export function due(iso: string | null | undefined, now = Date.now()): { text: string; late: boolean } | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now;
  const late = diff < 0;
  const h = Math.abs(diff) / 3600e3;
  const span = h < 24 ? `${Math.max(1, Math.round(h))} ч` : `${Math.round(h / 24)} ${plural(Math.round(h / 24), 'день', 'дня', 'дней')}`;
  return { text: late ? `просрочено на ${span}` : `через ${span}`, late };
}

export const date = (iso: string) => dateFmt.format(new Date(iso));
export const dateTime = (iso: string) => dateTimeFmt.format(new Date(iso));

export function hours(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (n < 1) return `${Math.round(n * 60)} мин`;
  if (n < 48) return `${n.toFixed(n < 10 ? 1 : 0).replace('.', ',')} ч`;
  return `${Math.round(n / 24)} ${plural(Math.round(n / 24), 'день', 'дня', 'дней')}`;
}

export const bytes = (n: number) => (n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1).replace('.', ',')} МБ`);
