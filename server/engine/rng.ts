/**
 * Seeded, *keyed* randomness. A random draw is a pure function of
 * (game seed, key parts) — e.g. (seed, '2027-03-14', 'retail', 'MDL-VELA').
 * This makes outcomes reproducible in tests and independent of how the player
 * chunks time (advancing 30×1 day yields exactly the same world as 1×30 days).
 */

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform [0,1) for the given key. */
  u(...key: (string | number)[]): number;
  /** Approximately normal(0,1) (Irwin–Hall with 4 draws, bounded to ±3.5). */
  n(...key: (string | number)[]): number;
  /** Bernoulli trial. */
  chance(p: number, ...key: (string | number)[]): boolean;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number, ...key: (string | number)[]): number;
  /** Integer uniform in [lo, hi]. */
  int(lo: number, hi: number, ...key: (string | number)[]): number;
}

export function makeRng(seed: number, enabled = true): Rng {
  const u = (...key: (string | number)[]) => {
    if (!enabled) return 0.5;
    const s = xmur3(`${seed}|${key.join('|')}`)();
    return mulberry32(s)();
  };
  const n = (...key: (string | number)[]) => {
    if (!enabled) return 0;
    let s = 0;
    for (let i = 0; i < 4; i++) s += u(...key, 'n', i);
    return (s - 2) * Math.sqrt(3); // var of sum of 4 U(0,1) is 1/3
  };
  return {
    u,
    n,
    chance: (p, ...key) => (enabled ? u(...key) < p : false),
    range: (lo, hi, ...key) => lo + (hi - lo) * u(...key),
    int: (lo, hi, ...key) => lo + Math.floor((hi - lo + 1) * u(...key)),
  };
}
