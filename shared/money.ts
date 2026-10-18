/**
 * Money is represented as integer euro cents everywhere in the simulation.
 * Floating point is only used for *rates and ratios*; every amount that is
 * posted to the ledger is rounded to an integer number of cents exactly once,
 * using the helpers below (round-half-away-from-zero, computed with BigInt).
 */
export type Cents = number;

export const CENTS_PER_EURO = 100;

/** Euros (may be fractional) -> cents. */
export function eur(euros: number): Cents {
  return Math.round(euros * CENTS_PER_EURO);
}

/** Millions of euros -> cents. */
export function mEur(millions: number): Cents {
  return Math.round(millions * 1_000_000 * CENTS_PER_EURO);
}

export function isCents(x: unknown): x is Cents {
  return typeof x === 'number' && Number.isSafeInteger(x);
}

export function assertCents(x: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(x)) throw new Error(`${label} must be an integer number of cents, got ${x}`);
  return x;
}

/** Round-half-away-from-zero integer division of BigInts. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('division by zero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

/** a * num / den with exact integer arithmetic; num/den must be integers. */
export function mulDiv(a: Cents, num: number, den: number): Cents {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new Error(`mulDiv requires integers (a=${a}, num=${num}, den=${den})`);
  }
  return Number(divRound(BigInt(a) * BigInt(num), BigInt(den)));
}

/** Apply a basis-point rate: a * bps / 10_000. */
export function bps(a: Cents, rateBps: number): Cents {
  return mulDiv(a, Math.round(rateBps), 10_000);
}

/**
 * Multiply an amount by a real-valued factor and round to cents.
 * The factor is quantised to 1e-9 so that the result is deterministic.
 */
export function scale(a: Cents, factor: number): Cents {
  const q = Math.round(factor * 1e9);
  return mulDiv(a, q, 1_000_000_000);
}

/** units * unitPrice, safely. */
export function times(unitCents: Cents, units: number): Cents {
  const r = unitCents * units;
  if (!Number.isSafeInteger(r)) {
    return Number(BigInt(unitCents) * BigInt(Math.round(units)));
  }
  return r;
}

export function sum(xs: Cents[]): Cents {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Split `total` into integer parts proportional to `weights` (largest remainder). */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (wsum <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map((w) => (total * w) / wsum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) floors[order[k].i] += 1;
  return floors;
}

export function fmtEur(c: Cents, opts: { compact?: boolean; decimals?: number; sign?: boolean } = {}): string {
  const euros = c / CENTS_PER_EURO;
  const sign = euros < 0 ? '−' : opts.sign && euros > 0 ? '+' : '';
  const a = Math.abs(euros);
  if (opts.compact !== false && a >= 1e9) return `${sign}€${(a / 1e9).toFixed(opts.decimals ?? 2)}bn`;
  if (opts.compact !== false && a >= 1e6) return `${sign}€${(a / 1e6).toFixed(opts.decimals ?? 1)}m`;
  if (opts.compact !== false && a >= 1e4) return `${sign}€${(a / 1e3).toFixed(opts.decimals ?? 0)}k`;
  return `${sign}€${a.toLocaleString('en-GB', { maximumFractionDigits: opts.decimals ?? 0, minimumFractionDigits: 0 })}`;
}

/** Parse "€50m", "50 million", "1.2bn", "€300,000" into cents. Returns null if not parseable. */
export function parseMoney(text: string): Cents | null {
  const m = text
    .toLowerCase()
    .replace(/,/g, '')
    .match(/(?:€|eur\s*)?\s*(\d+(?:\.\d+)?)\s*(bn|billion|b|m|mn|million|k|thousand)?\b/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const mult = /^(bn|billion|b)$/.test(unit) ? 1e9 : /^(m|mn|million)$/.test(unit) ? 1e6 : /^(k|thousand)$/.test(unit) ? 1e3 : 1;
  return eur(n * mult);
}
