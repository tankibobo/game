/** Simulation dates are ISO calendar dates ("YYYY-MM-DD") interpreted in UTC. */
export type SimDate = string;

const DAY_MS = 86_400_000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

export function isSimDate(s: unknown): s is SimDate {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function toDate(d: SimDate): Date {
  if (!isSimDate(d)) throw new Error(`invalid date: ${d}`);
  return new Date(`${d}T00:00:00Z`);
}

export function fromDate(d: Date): SimDate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: SimDate, n: number): SimDate {
  return fromDate(new Date(toDate(d).getTime() + n * DAY_MS));
}

export function diffDays(a: SimDate, b: SimDate): number {
  return Math.round((toDate(a).getTime() - toDate(b).getTime()) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(d: SimDate): number {
  return toDate(d).getUTCDay();
}

export function isWeekend(d: SimDate): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

export function year(d: SimDate): number {
  return Number(d.slice(0, 4));
}

/** 1..12 */
export function month(d: SimDate): number {
  return Number(d.slice(5, 7));
}

export function dayOfMonth(d: SimDate): number {
  return Number(d.slice(8, 10));
}

export function monthKey(d: SimDate): string {
  return d.slice(0, 7);
}

export function quarterKey(d: SimDate): string {
  return `${year(d)}-Q${Math.floor((month(d) - 1) / 3) + 1}`;
}

export function daysInMonth(d: SimDate): number {
  const y = year(d);
  const m = month(d);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function firstOfMonth(d: SimDate): SimDate {
  return `${d.slice(0, 7)}-01`;
}

export function lastOfMonth(d: SimDate): SimDate {
  return `${d.slice(0, 7)}-${String(daysInMonth(d)).padStart(2, '0')}`;
}

export function isMonthEnd(d: SimDate): boolean {
  return dayOfMonth(d) === daysInMonth(d);
}

export function isQuarterEnd(d: SimDate): boolean {
  return isMonthEnd(d) && month(d) % 3 === 0;
}

export function isYearEnd(d: SimDate): boolean {
  return d.slice(5) === '12-31';
}

export function addMonths(d: SimDate, n: number): SimDate {
  const y = year(d);
  const m = month(d) - 1 + n;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const day = Math.min(dayOfMonth(d), dim);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function minDate(a: SimDate, b: SimDate): SimDate {
  return a <= b ? a : b;
}

export function maxDate(a: SimDate, b: SimDate): SimDate {
  return a >= b ? a : b;
}

/** Inclusive range check. */
export function inRange(d: SimDate, start: SimDate, end: SimDate): boolean {
  return d >= start && d <= end;
}

/** Fixed public holidays applied to all plants (simplified pan-European calendar). */
const HOLIDAYS_MD = new Set(['01-01', '05-01', '12-25', '12-26']);

export function isPublicHoliday(d: SimDate): boolean {
  return HOLIDAYS_MD.has(d.slice(5));
}

export function isWorkingDay(d: SimDate): boolean {
  return !isWeekend(d) && !isPublicHoliday(d);
}

export function workingDaysBetween(startInclusive: SimDate, endInclusive: SimDate): number {
  let n = 0;
  for (let d = startInclusive; d <= endInclusive; d = addDays(d, 1)) if (isWorkingDay(d)) n++;
  return n;
}

/** Add N working days (N >= 0) to a date. */
export function addWorkingDays(d: SimDate, n: number): SimDate {
  let cur = d;
  let left = Math.max(0, Math.ceil(n));
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur)) left--;
  }
  return cur;
}

/** Fourth Thursday of a month — regular board meetings are held then. */
export function fourthThursday(y: number, m: number): SimDate {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (4 - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + 21;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmtDate(d: SimDate, style: 'long' | 'short' | 'month' = 'short'): string {
  if (!isSimDate(d)) return String(d ?? '—');
  const dt = toDate(d);
  const mName = MONTHS[dt.getUTCMonth()];
  if (style === 'month') return `${mName} ${dt.getUTCFullYear()}`;
  if (style === 'long') return `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${mName} ${dt.getUTCFullYear()}`;
  return `${dt.getUTCDate()} ${mName.slice(0, 3)} ${dt.getUTCFullYear()}`;
}

export function monthName(m: number): string {
  return MONTHS[m - 1];
}

/** Parse loose natural-language dates such as "by September", "end of Q3", "2027-09-30", "December 2027". */
export function parseLooseDate(text: string, today: SimDate): SimDate | null {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && isSimDate(iso[1])) return iso[1];
  const lower = text.toLowerCase();
  const q = lower.match(/\b(?:end of\s+)?q([1-4])(?:\s+(\d{4}))?\b/);
  if (q) {
    const qy = q[2] ? Number(q[2]) : year(today);
    const m = Number(q[1]) * 3;
    let d = lastOfMonth(`${qy}-${String(m).padStart(2, '0')}-01`);
    if (!q[2] && d < today) d = lastOfMonth(`${qy + 1}-${String(m).padStart(2, '0')}-01`);
    return d;
  }
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i].toLowerCase();
    const re = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+)?(?:${name}|${name.slice(0, 3)})\\b(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(\\d{4}))?`);
    const m = lower.match(re);
    if (m) {
      let y = m[3] ? Number(m[3]) : year(today);
      const mm = String(i + 1).padStart(2, '0');
      const dayStr = m[1] ?? m[2];
      let d = dayStr ? `${y}-${mm}-${String(Number(dayStr)).padStart(2, '0')}` : lastOfMonth(`${y}-${mm}-01`);
      if (!isSimDate(d)) d = lastOfMonth(`${y}-${mm}-01`);
      if (!m[3] && d < today) {
        y += 1;
        d = dayStr ? `${y}-${mm}-${String(Number(dayStr)).padStart(2, '0')}` : lastOfMonth(`${y}-${mm}-01`);
      }
      return d;
    }
  }
  return null;
}
