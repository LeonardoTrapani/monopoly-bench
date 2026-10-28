/**
 * `mb calibrate`: distribution of natural game lengths (full rounds) of bot games per
 * player count, used to choose the `maxRounds` turn cap (SPEC §12).
 */
import { runBotGame } from "@mb/sim";

import { intFlag, parseFlags, table } from "./cli.ts";
import { parsePolicies, ruleOverrides } from "./sim.ts";

import type { CliCommand } from "./cli.ts";

const percentile = (sorted: ReadonlyArray<number>, fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;

const percent = (count: number, total: number): string =>
  total === 0 ? "-" : `${((100 * count) / total).toFixed(1)}%`;

export const calibrateCommand: CliCommand = {
  name: "calibrate",
  summary: "Measure natural game lengths of bot games to calibrate maxRounds.",
  usage:
    "mb calibrate [--games N] [--players 2,3,4,5,6] [--bot heuristic] [--cap ROUNDS] [--seed PREFIX] [--table-frequency F]",
  run: async (args) => {
    const flags = parseFlags(args, {
      games: { type: "string" },
      players: { type: "string" },
      bot: { type: "string" },
      cap: { type: "string" },
      seed: { type: "string" },
      "table-frequency": { type: "string" },
    });

    const games = intFlag(flags, "games", 200);
    const cap = intFlag(flags, "cap", 1000);
    const prefix = flags.strings.get("seed") ?? "calibrate";
    const counts = (flags.strings.get("players") ?? "2,3,4,5,6").split(",").map(Number);
    const rules = ruleOverrides(String(cap), flags.strings.get("table-frequency"));

    const rows = [
      ["players", "games", "natural", "p50", "p90", "p95", "p99", "max", "≤100", "≤150", "ms/game"],
    ];

    for (const players of counts) {
      const policies = parsePolicies(
        Array.from({ length: players }, () => flags.strings.get("bot") ?? "heuristic").join(","),
        players,
      );

      const natural: Array<number> = [];
      const started = performance.now();

      for (let index = 0; index < games; index += 1) {
        const result = runBotGame({
          gameId: `${prefix}-${players}p-${index}`,
          seed: `${prefix}-${players}p-${index}`,
          policies,
          rules,
        });

        if (result.state.endReason === "lastPlayerStanding") natural.push(result.rounds);
      }

      const sorted = natural.toSorted((left, right) => left - right);
      const within = (limit: number) => sorted.filter((rounds) => rounds <= limit).length;

      rows.push([
        String(players),
        String(games),
        percent(sorted.length, games),
        String(percentile(sorted, 0.5)),
        String(percentile(sorted, 0.9)),
        String(percentile(sorted, 0.95)),
        String(percentile(sorted, 0.99)),
        String(sorted.at(-1) ?? 0),
        percent(within(100), games),
        percent(within(150), games),
        String(Math.round((performance.now() - started) / games)),
      ]);
      console.log(table(rows));
      console.log("");
    }

    return 0;
  },
};
