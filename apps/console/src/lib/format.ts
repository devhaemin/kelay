// Formatting shared by server and client renders. Everything takes `now` explicitly and uses a
// fixed time zone so the server HTML and the hydrated client agree.
const TZ = 'Asia/Seoul';

const dayFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: TZ });
const dateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: '2-digit', year: 'numeric', timeZone: TZ });
const longDateFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ });

/** "Nov 6" */
export const formatDay = (iso: string): string => dayFmt.format(new Date(iso));
/** "Oct 02, 2026" */
export const formatDate = (iso: string): string => dateFmt.format(new Date(iso));
/** "Nov 11, 2026" */
export const formatLongDate = (iso: string): string => longDateFmt.format(new Date(iso));
/** "10:41" */
export const formatTime = (iso: string): string => timeFmt.format(new Date(iso));
/** "14" (hour of day) */
export const formatHour = (iso: string): string => `${timeFmt.format(new Date(iso)).slice(0, 2)}:00`;

/** 1900 → "1.9k"; null → "—". */
export function formatCompact(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** App cards: "2h ago", "Yesterday", "3d ago". */
export function formatAgoShort(iso: string, now: number): string {
  const d = now - new Date(iso).getTime();
  if (d < MIN) return 'Just now';
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < 2 * DAY) return 'Yesterday';
  if (d < 30 * DAY) return `${Math.floor(d / DAY)}d ago`;
  return formatDay(iso);
}

/** Tables: "2 min ago", "1 hour ago", "Yesterday", "3 days ago", "1 week ago"; null → "—". */
export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return '—';
  const d = now - new Date(iso).getTime();
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (d < MIN) return 'Just now';
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return plural(Math.floor(d / HOUR), 'hour');
  if (d < 2 * DAY) return 'Yesterday';
  if (d < 7 * DAY) return plural(Math.floor(d / DAY), 'day');
  if (d < 30 * DAY) return plural(Math.floor(d / (7 * DAY)), 'week');
  return formatDate(iso);
}

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const firstName = (name: string): string => name.split(/\s+/)[0] ?? name;

const AVATAR_COLORS = ['#4f6bff', '#1f9d55', '#b7791f', '#8b5cf6', '#d64545', '#0ea5e9'];

export function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#71717a';
}

export const possessive = (name: string): string => `${name}’s`;
