const UINT32 = 4_294_967_296;
const MULBERRY_INCREMENT = 0x6d_2b_79_f5;
const SHIFT_A = 15;
const SHIFT_B = 7;
const SHIFT_C = 14;
const MIX_A = 61;

/**
 * mulberry32: tiny, fast, seedable PRNG. Same seed → same sequence, so seeded
 * datasets (and benchmark results) are reproducible.
 */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + MULBERRY_INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> SHIFT_A), t | 1);
    t ^= t + Math.imul(t ^ (t >>> SHIFT_B), t | MIX_A);
    return ((t ^ (t >>> SHIFT_C)) >>> 0) / UINT32;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick() requires a non-empty list');
  return item;
}
