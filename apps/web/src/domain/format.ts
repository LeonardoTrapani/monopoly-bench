/** Pure formatting helpers for money, rates, durations and timestamps. */

const THOUSAND = 1000;

const MILLION = 1_000_000;

const CENT = 0.01;

const MILLIS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

const PERCENT = 100;

const groupDigits = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Game money: `$1,500`, negative as `−$40`. */
export const money = (amount: number): string =>
  amount < 0 ? `−$${groupDigits(-amount)}` : `$${groupDigits(amount)}`;

/** Compact game money: `$1.2k`, `$15k`. */
export const moneyCompact = (amount: number): string => {
  if (Math.abs(amount) >= MILLION) return `$${(amount / MILLION).toFixed(1)}M`;

  if (Math.abs(amount) >= 10 * THOUSAND) return `$${Math.round(amount / THOUSAND)}k`;

  if (Math.abs(amount) >= THOUSAND) return `$${(amount / THOUSAND).toFixed(1)}k`;

  return money(amount);
};

/** Real dollars spent on model calls: `$0.042`, `$1.25`, `$120`. */
export const usd = (amount: number): string => {
  if (amount === 0) return "$0";

  if (amount < CENT) return `$${amount.toFixed(4)}`;

  if (amount < 1) return `$${amount.toFixed(3)}`;

  if (amount < 100) return `$${amount.toFixed(2)}`;

  return `$${groupDigits(amount)}`;
};

/** A 0–1 rate as a percentage: `42.5%`. */
export const percent = (rate: number, digits = 1): string => `${(rate * PERCENT).toFixed(digits)}%`;

/** Milliseconds as `850 ms`, `3.2 s` or `2m 05s`. */
export const duration = (millis: number): string => {
  if (millis < MILLIS_PER_SECOND) return `${Math.round(millis)} ms`;

  const seconds = millis / MILLIS_PER_SECOND;

  if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)} s`;

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rest = Math.round(seconds - minutes * SECONDS_PER_MINUTE);

  return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
};

/** Token counts: `812`, `12.4k`, `1.2M`. */
export const tokens = (count: number): string => {
  if (count >= MILLION) return `${(count / MILLION).toFixed(1)}M`;

  if (count >= THOUSAND) return `${(count / THOUSAND).toFixed(1)}k`;

  return `${count}`;
};

/** One decimal: `23.4`. */
export const decimal = (value: number, digits = 1): string => value.toFixed(digits);

/** Integer with thousands separators: `12,345`. */
export const integer = (value: number): string => groupDigits(value);

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** An ISO timestamp as `Oct 28, 14:05 UTC`; unparsable input is returned unchanged. */
export const timestamp = (iso: string): string => {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  const month = MONTHS[date.getUTCMonth()] ?? "";
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");

  return `${month} ${date.getUTCDate()}, ${hours}:${minutes} UTC`;
};

/** An ISO timestamp as `Oct 28`. */
export const day = (iso: string): string => {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  return `${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`;
};

/** Ordinal place: `1st`, `2nd`, `3rd`, `4th`. */
export const ordinal = (place: number): string => {
  const rounded = Math.round(place);
  const lastTwo = rounded % 100;

  if (lastTwo >= 11 && lastTwo <= 13) return `${rounded}th`;

  const suffix = ["th", "st", "nd", "rd"][rounded % 10] ?? "th";

  return `${rounded}${rounded % 10 > 3 ? "th" : suffix}`;
};

/** Singular or plural noun: `1 game`, `3 games`. */
export const plural = (count: number, noun: string, pluralNoun = `${noun}s`): string =>
  `${integer(count)} ${count === 1 ? noun : pluralNoun}`;
