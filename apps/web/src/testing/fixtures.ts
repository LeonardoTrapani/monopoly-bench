/** The sim fixtures (real bot games) and sample API payloads, for tests. */
import type { GameSummary, Leaderboard, LeaderboardEntry } from "@mb/api";
import { GameConfig, GameEventJson, type GameEvent } from "@mb/engine";
import { Schema } from "effect";

import sample2pConfig from "../../../../packages/sim/fixtures/sample-2p.config.json";
import sample2pEvents from "../../../../packages/sim/fixtures/sample-2p.events.jsonl?raw";

const decodeEvent = Schema.decodeUnknownSync(GameEventJson);

export const sample2p = {
  config: Schema.decodeUnknownSync(GameConfig)(sample2pConfig),
  events: sample2pEvents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): GameEvent => decodeEvent(line)),
};

export const entry = (
  competitorId: string,
  score: number,
  games: number,
  wins: number,
): LeaderboardEntry => ({
  competitorId,
  label: competitorId.toUpperCase(),
  kind: competitorId.startsWith("bot:") ? "bot" : "llm",
  mu: score + 6,
  sigma: 2,
  score,
  games,
  wins,
  avgPlace: 2,
  avgNetWorth: 3000,
  invalidRate: 0.01,
  timeoutRate: 0,
  costPerGameUsd: 1,
  avgWakeMs: 5000,
});

export const leaderboard = (playersCount: 2 | 3 | 4 | 5 | 6): Leaderboard => ({
  playersCount,
  updatedAt: null,
  entries: [
    entry("a/alpha", 20, 40, 10),
    entry("b/beta", 30, 50, 30),
    entry("bot:random", 5, 80, 4),
  ],
  headToHead: [{ a: "a/alpha", b: "b/beta", games: 10, aAhead: 3 }],
});

export const summary = (status: GameSummary["status"]): GameSummary => ({
  id: "game-1",
  runId: "run-1",
  seed: "sample-2p",
  status,
  playersCount: 2,
  startedAt: "2026-10-28T08:00:00.000Z",
  finishedAt: null,
  turn: 10,
  round: 5,
  endReason: null,
  winnerSeat: null,
  seats: [],
});
