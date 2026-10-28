/** `mb sim`: play one bot game in-process, print the standings, write the event log. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { BOT_POLICIES, isBotPolicy } from "@mb/bots";
import { GameConfig, GameEventJson, TableFrequency } from "@mb/engine";
import { runBotGame } from "@mb/sim";

import { intFlag, parseFlags, table } from "./cli.ts";

import type { CliCommand } from "./cli.ts";
import type { BotPolicy } from "@mb/bots";
import type { GameEvent, RulesConfig } from "@mb/engine";
import type { GameResult } from "@mb/sim";

const encodeEvent = Schema.encodeSync(GameEventJson);

const encodeConfig = Schema.encodeSync(GameConfig);

const decodeFrequency = Schema.decodeUnknownSync(TableFrequency);

/** Writes `<dir>/<gameId>.config.json` and `<dir>/<gameId>.events.jsonl`. */
export const writeGameFiles = (
  dir: string,
  config: GameConfig,
  events: ReadonlyArray<GameEvent>,
): ReadonlyArray<string> => {
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, `${config.gameId}.config.json`);
  const eventsPath = join(dir, `${config.gameId}.events.jsonl`);

  writeFileSync(configPath, `${JSON.stringify(encodeConfig(config), null, 2)}\n`);
  writeFileSync(eventsPath, `${events.map((event) => encodeEvent(event)).join("\n")}\n`);

  return [configPath, eventsPath];
};

/** Parses `--bots a,b,c` (or alternates heuristic / random for `players` seats). */
export const parsePolicies = (
  raw: string | undefined,
  players: number,
): ReadonlyArray<BotPolicy> => {
  if (raw === undefined) {
    return Array.from({ length: players }, (_, index): BotPolicy =>
      index % 2 === 0 ? "heuristic" : "random",
    );
  }

  const names = raw.split(",").map((name) => name.trim());

  return names.map((name) => {
    if (!isBotPolicy(name))
      throw new Error(`unknown bot "${name}" (use ${BOT_POLICIES.join(", ")})`);

    return name;
  });
};

/** Rule overrides shared by `sim` and `calibrate`. */
export const ruleOverrides = (
  maxRounds: string | undefined,
  frequency: string | undefined,
): Partial<RulesConfig> => {
  const rounds: Partial<RulesConfig> =
    maxRounds === undefined ? {} : { maxRounds: Number(maxRounds) };

  return frequency === undefined
    ? rounds
    : { ...rounds, tableFrequency: decodeFrequency(frequency) };
};

const printResult = (result: GameResult, ms: number): void => {
  const labels = new Map(result.config.seats.map((seat) => [seat.seat, seat.label]));
  const stats = new Map(result.stats.map((entry) => [entry.seat, entry]));

  const rows = [
    [
      "rank",
      "seat",
      "player",
      "net worth",
      "cash",
      "bankrupt at turn",
      "wakes",
      "invalid",
      "timeouts",
    ],
    ...result.standings.map((row) => [
      String(row.rank),
      row.seat,
      labels.get(row.seat) ?? row.seat,
      `$${row.netWorth}`,
      `$${row.cash}`,
      row.bankruptAtTurn === null ? "-" : String(row.bankruptAtTurn),
      String(stats.get(row.seat)?.wakes ?? 0),
      String(stats.get(row.seat)?.invalid ?? 0),
      String(stats.get(row.seat)?.timeouts ?? 0),
    ]),
  ];

  console.log(
    `Game ${result.config.gameId} (seed ${result.config.seed}): ${result.state.endReason ?? "unfinished"} after ${result.rounds} rounds, ${result.turns} turns, ${result.events.length} events, ${Math.round(ms)} ms.`,
  );
  console.log(table(rows));
};

export const simCommand: CliCommand = {
  name: "sim",
  summary: "Play a bot game in-process, print the standings and write the event log.",
  usage:
    "mb sim [--players N] [--seed S] [--bots heuristic,random,...] [--max-rounds R] [--table-frequency everyRoll|everyTurn|everyRound|off] [--game-id ID] [--out DIR] [--no-out] [--verify]",
  run: async (args) => {
    const flags = parseFlags(args, {
      players: { type: "string" },
      seed: { type: "string" },
      bots: { type: "string" },
      "max-rounds": { type: "string" },
      "table-frequency": { type: "string" },
      "game-id": { type: "string" },
      out: { type: "string" },
      "no-out": { type: "boolean" },
      verify: { type: "boolean" },
    });

    const botsFlag = flags.strings.get("bots");
    const players = intFlag(flags, "players", botsFlag?.split(",").length ?? 4);
    const policies = parsePolicies(botsFlag, players);

    if (policies.length !== players || players < 2 || players > 6) {
      throw new Error(
        `need 2 to 6 players and one bot per player (got ${policies.length} bots for ${players} players)`,
      );
    }

    const seed = flags.strings.get("seed") ?? "1";
    const gameId = flags.strings.get("game-id") ?? `sim-${players}p-${seed}`;
    const started = performance.now();

    const result = runBotGame({
      gameId,
      seed,
      policies,
      rules: ruleOverrides(flags.strings.get("max-rounds"), flags.strings.get("table-frequency")),
      verify: flags.booleans.has("verify"),
    });

    printResult(result, performance.now() - started);

    if (!flags.booleans.has("no-out")) {
      const written = writeGameFiles(
        flags.strings.get("out") ?? "out",
        result.config,
        result.events,
      );

      console.log(`Wrote ${written.join(" and ")}.`);
    }

    return 0;
  },
};
