export { fmtEur } from '../../shared/money';
export { fmtDate, addDays, diffDays } from '../../shared/dates';

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-GB'));
export const fmtPct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
export const fmtX = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x >= 50 ? 'n/m' : `${x.toFixed(2)}x`);
export const eurM = (cents: number) => Math.round(cents / 1e6) / 100; // € millions with 2 decimals
export const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
