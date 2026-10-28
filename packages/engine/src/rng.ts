/**
 * Counter-based deterministic randomness (SPEC §4.1): value `n` of a stream is a pure
 * function of `(key, n)`, where `key` is a hash of the seed string. The state keeps
 * the counter; events that consume randomness carry the outcome and the new counter.
 */

/** FNV-1a hash of a string to an unsigned 32-bit integer. */
export const hashString = (text: string): number => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
};

/** murmur3 finalizer: a strong 32-bit mix. */
const fmix32 = (input: number): number => {
  let value = input;

  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;

  return value >>> 0;
};

/** Uniform float in [0, 1) for counter `n` of stream `key`. */
export const rngAt = (key: number, n: number): number => {
  const mixed = fmix32((key ^ fmix32(Math.imul(n + 1, 0x9e3779b9) >>> 0)) >>> 0);

  return mixed / 4294967296;
};

/** Integer in [0, size) for counter `n` of stream `key`. */
export const rngInt = (key: number, n: number, size: number): number =>
  Math.floor(rngAt(key, n) * size);

/** One die (1–6) for counter `n`. */
export const rollDie = (key: number, n: number): number => 1 + rngInt(key, n, 6);

export interface Shuffle {
  readonly order: ReadonlyArray<number>;
  /** First unused counter. */
  readonly next: number;
}

/** Fisher–Yates shuffle of `0..size-1` using counters `start..start+size-2`. */
export const shuffledRange = (key: number, start: number, size: number): Shuffle => {
  const order = Array.from({ length: size }, (_, index) => index);
  let counter = start;

  for (let index = size - 1; index > 0; index -= 1) {
    const swap = rngInt(key, counter, index + 1);
    const current = order[index] ?? 0;

    counter += 1;
    order[index] = order[swap] ?? 0;
    order[swap] = current;
  }

  return { order, next: counter };
};
