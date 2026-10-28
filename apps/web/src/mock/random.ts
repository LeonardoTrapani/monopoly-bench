/** Deterministic pseudo-randomness for the mock API (same data on every load). */
import { hashString } from "@mb/engine";

/** A float in [0, 1) derived from `key` alone. */
export const unit = (key: string): number => {
  let state = hashString(key) >>> 0;

  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d);
  state = Math.imul(state ^ (state >>> 12), 0x297a2d39);
  state ^= state >>> 15;

  return (state >>> 0) / 4294967296;
};

/** A float in [min, max). */
export const between = (key: string, min: number, max: number): number =>
  min + unit(key) * (max - min);

/** An integer in [min, max]. */
export const intBetween = (key: string, min: number, max: number): number =>
  Math.floor(between(key, min, max + 1));

/** One element of `items`, chosen by `key`. */
export const pick = <A>(key: string, items: ReadonlyArray<A>, fallback: A): A =>
  items[Math.floor(unit(key) * items.length)] ?? fallback;

/** Roughly normal noise with mean 0 and the given spread. */
export const noise = (key: string, spread: number): number =>
  (unit(`${key}:1`) + unit(`${key}:2`) + unit(`${key}:3`) - 1.5) * spread;
