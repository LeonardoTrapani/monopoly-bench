/** Minimal command framework: each command parses its own flags and returns an exit code. */
import { parseArgs } from "node:util";

export interface CliCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly run: (args: ReadonlyArray<string>) => Promise<number>;
}

export type FlagSpec = Readonly<Record<string, { readonly type: "string" | "boolean" }>>;

export interface ParsedFlags {
  readonly strings: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

/** Parses `--name value` / `--flag` arguments (strict: unknown flags are errors). */
export const parseFlags = (args: ReadonlyArray<string>, spec: FlagSpec): ParsedFlags => {
  const parsed = parseArgs({
    args: [...args],
    options: spec,
    strict: true,
    allowPositionals: false,
  });

  const strings = new Map<string, string>();
  const booleans = new Set<string>();

  for (const [name, value] of Object.entries(parsed.values)) {
    if (value === true) booleans.add(name);
    else if (value !== false && value !== undefined) strings.set(name, String(value));
  }

  return { strings, booleans };
};

export const intFlag = (flags: ParsedFlags, name: string, fallback: number): number => {
  const raw = flags.strings.get(name);

  if (raw === undefined) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer, got "${raw}"`);

  return value;
};

/** Left-pads / right-pads cells into an aligned plain-text table. */
export const table = (rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths: Array<number> = [];

  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }

  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  "))
    .join("\n");
};
