/**
 * Mock games: the sim fixtures (real heuristic/random bot games) and a few bot games generated in
 * the browser, relabelled with model lineups. Summaries come from replaying them with the engine,
 * so lists, replays and standings always agree.
 */
import { PlayersCount, type GameSeatSummary, type GameSummary } from "@mb/api";
import {
  GameConfig,
  GameEventJson,
  replay,
  standings,
  type GameEvent,
  type GameState,
  type SeatConfig,
} from "@mb/engine";
import { runBotGame } from "@mb/sim";
import { Option, Predicate, Schema } from "effect";

import sample2pConfig from "../../../../packages/sim/fixtures/sample-2p.config.json";
import sample2pEvents from "../../../../packages/sim/fixtures/sample-2p.events.jsonl?raw";
import sample4pConfig from "../../../../packages/sim/fixtures/sample-4p.config.json";
import sample4pEvents from "../../../../packages/sim/fixtures/sample-4p.events.jsonl?raw";
import { COMPETITORS, competitorById } from "./competitors.ts";
import { between, intBetween, pick, unit } from "./random.ts";

type BotPolicy = "random" | "heuristic";

type GameSource =
  | Readonly<{ kind: "Fixture"; name: "sample-4p" | "sample-2p" }>
  | Readonly<{ kind: "Bots"; seed: string; policies: ReadonlyArray<BotPolicy>; maxRounds: number }>;

export interface MockGameDef {
  readonly id: string;
  readonly runId: string;
  readonly lineup: ReadonlyArray<string>;
  readonly source: GameSource;
  readonly startedAt: string;
  readonly isLive: boolean;
}

export interface LoadedGame {
  readonly config: GameConfig;
  readonly events: ReadonlyArray<GameEvent>;
}

const OPUS = "anthropic/claude-opus-5.5:high";
const SOL = "openai/gpt-6.1-sol:high";
const GEMINI = "google/gemini-4-argon";
const SONNET = "anthropic/claude-sonnet-5.5";
const GROK = "x-ai/grok-4.7";
const ASTRA = "openai/gpt-6-astra";
const DEEPSEEK = "deepseek/deepseek-v4-pro-0813";
const KIMI = "moonshotai/kimi-k3.1-pro";
const QWEN = "qwen/qwen3.8-max-0902";
const GLM = "z-ai/glm-5.3";
const HAIKU = "anthropic/claude-haiku-5.5";
const MISTRAL = "mistralai/mistral-large-4-0";
const HEURISTIC = "bot:heuristic";
const RANDOM = "bot:random";

export const LIVE_GAME_ID = "g-live-frontier-4p";

export const GAME_DEFS: ReadonlyArray<MockGameDef> = [
  {
    id: LIVE_GAME_ID,
    runId: "run-frontier-4p",
    lineup: [OPUS, SONNET, SOL, GEMINI],
    source: { kind: "Fixture", name: "sample-4p" },
    startedAt: "2026-10-28T07:58:00.000Z",
    isLive: true,
  },
  {
    id: "g-frontier-4p-01",
    runId: "run-frontier-4p",
    lineup: [OPUS, SOL, GEMINI, SONNET],
    source: { kind: "Fixture", name: "sample-4p" },
    startedAt: "2026-10-28T06:12:00.000Z",
    isLive: false,
  },
  {
    id: "g-open-4p-01",
    runId: "run-open-4p",
    lineup: [GROK, ASTRA, DEEPSEEK, HEURISTIC],
    source: { kind: "Fixture", name: "sample-4p" },
    startedAt: "2026-10-27T18:40:00.000Z",
    isLive: false,
  },
  {
    id: "g-open-4p-02",
    runId: "run-open-4p",
    lineup: [KIMI, QWEN, GLM, MISTRAL],
    source: { kind: "Fixture", name: "sample-4p" },
    startedAt: "2026-10-27T16:05:00.000Z",
    isLive: false,
  },
  {
    id: "g-heads-up-01",
    runId: "run-heads-up",
    lineup: [OPUS, RANDOM],
    source: { kind: "Fixture", name: "sample-2p" },
    startedAt: "2026-10-26T10:20:00.000Z",
    isLive: false,
  },
  {
    id: "g-heads-up-02",
    runId: "run-heads-up",
    lineup: [SONNET, HAIKU],
    source: { kind: "Fixture", name: "sample-2p" },
    startedAt: "2026-10-26T09:41:00.000Z",
    isLive: false,
  },
  {
    id: "g-big-3p-01",
    runId: "run-big-3p",
    lineup: [GEMINI, GROK, HAIKU],
    source: {
      kind: "Bots",
      seed: "mock-3p",
      policies: ["heuristic", "heuristic", "random"],
      maxRounds: 60,
    },
    startedAt: "2026-10-25T14:00:00.000Z",
    isLive: false,
  },
  {
    id: "g-big-5p-01",
    runId: "run-big-5p",
    lineup: [SONNET, ASTRA, DEEPSEEK, KIMI, HEURISTIC],
    source: {
      kind: "Bots",
      seed: "mock-5p",
      policies: ["heuristic", "random", "heuristic", "random", "heuristic"],
      maxRounds: 50,
    },
    startedAt: "2026-10-25T15:30:00.000Z",
    isLive: false,
  },
  {
    id: "g-big-6p-01",
    runId: "run-big-6p",
    lineup: [OPUS, SOL, GEMINI, GLM, QWEN, RANDOM],
    source: {
      kind: "Bots",
      seed: "mock-6p",
      policies: ["heuristic", "heuristic", "heuristic", "random", "random", "random"],
      maxRounds: 40,
    },
    startedAt: "2026-10-25T17:10:00.000Z",
    isLive: false,
  },
];

const decodeConfig = Schema.decodeUnknownSync(GameConfig);

const decodePlayers = Schema.decodeUnknownOption(PlayersCount);

const decodeEvent = Schema.decodeUnknownSync(GameEventJson);

const parseEvents = (text: string): ReadonlyArray<GameEvent> =>
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeEvent(line));

const fixtureCache = new Map<string, LoadedGame>();

const loadFixture = (name: "sample-4p" | "sample-2p"): LoadedGame => {
  const cached = fixtureCache.get(name);

  if (cached !== undefined) return cached;

  const loaded =
    name === "sample-4p"
      ? { config: decodeConfig(sample4pConfig), events: parseEvents(sample4pEvents) }
      : { config: decodeConfig(sample2pConfig), events: parseEvents(sample2pEvents) };

  fixtureCache.set(name, loaded);

  return loaded;
};

const OFFER_COMMENTS: ReadonlyArray<string> = [
  "This completes your set as much as mine. Fair split?",
  "Cash now beats rent later. Take it.",
  "I need the orange set; you need liquidity. Everyone wins.",
  "Final offer before I start building elsewhere.",
  "You are two turns from bankruptcy on my railroads. Let's make a deal.",
  "Swap? Neither of us can build with what we hold now.",
  "Throwing in cash to sweeten it.",
];

const REJECT_COMMENTS: ReadonlyArray<string> = [
  "Not for a monopoly. Add $150 and we talk.",
  "No thanks, that set is worth more to me.",
  "Too low.",
  "I'd rather take my chances at auction.",
];

/** Relabels seats with the lineup and adds negotiation comments the bots never write. */
const dress = (def: MockGameDef, game: LoadedGame): LoadedGame => {
  const seats: ReadonlyArray<SeatConfig> = game.config.seats.map((seat, index) => {
    const competitor = competitorById(def.lineup[index] ?? "") ?? COMPETITORS[0];

    return {
      seat: seat.seat,
      label: competitor?.label ?? seat.label,
      competitorId: competitor?.competitorId ?? seat.competitorId,
    };
  });

  const config: GameConfig = { ...game.config, gameId: def.id, seats };

  const events = game.events.map((event): GameEvent => {
    if (Predicate.isTagged(event, "GameStarted")) return { ...event, gameId: def.id, seats };

    if (
      Predicate.isTagged(event, "OfferPosted") &&
      event.offer.comment === null &&
      unit(`${def.id}:offer:${event.seq}`) < 0.75
    ) {
      return {
        ...event,
        offer: {
          ...event.offer,
          comment: pick(`${def.id}:comment:${event.seq}`, OFFER_COMMENTS, ""),
        },
      };
    }

    if (
      Predicate.isTagged(event, "OfferRejected") &&
      event.comment === null &&
      unit(`${def.id}:reject:${event.seq}`) < 0.6
    ) {
      return {
        ...event,
        comment: pick(`${def.id}:rejectComment:${event.seq}`, REJECT_COMMENTS, ""),
      };
    }

    return event;
  });

  return { config, events };
};

const gameCache = new Map<string, LoadedGame>();

/** Config and full event log of a mock game. */
export const loadGame = (def: MockGameDef): LoadedGame => {
  const cached = gameCache.get(def.id);

  if (cached !== undefined) return cached;

  const raw =
    def.source.kind === "Fixture"
      ? loadFixture(def.source.name)
      : runBotGame({
          gameId: def.id,
          seed: def.source.seed,
          policies: def.source.policies,
          rules: { maxRounds: def.source.maxRounds },
        });

  const loaded = dress(def, { config: raw.config, events: raw.events });

  gameCache.set(def.id, loaded);

  return loaded;
};

export const gameDef = (gameId: string): MockGameDef | undefined =>
  GAME_DEFS.find((def) => def.id === gameId);

const addMinutes = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

const seatSummaries = (
  def: MockGameDef,
  state: GameState,
  isFinished: boolean,
): ReadonlyArray<GameSeatSummary> => {
  const rows = standings(state);

  return state.players.map((player) => {
    const competitor = competitorById(player.competitorId);
    const row = rows.find((standing) => standing.seat === player.seat);
    const isBot = player.competitorId.startsWith("bot:");

    const wakes = isBot
      ? 0
      : Math.round(state.control.turn * between(`${def.id}:${player.seat}:wakes`, 1.4, 2.2));

    return {
      seat: player.seat,
      competitorId: player.competitorId,
      label: player.label,
      kind: isBot ? "bot" : "llm",
      finalRank: isFinished ? (row?.rank ?? null) : null,
      netWorth: row?.netWorth ?? null,
      cash: player.cash,
      bankruptAtTurn: player.bankruptcy?.turn ?? null,
      costUsd: isBot ? 0 : ((competitor?.costPerGameUsd ?? 1) * state.control.turn) / 150,
      wakes,
      invalidActions: isBot
        ? 0
        : Math.round(
            wakes *
              (competitor?.invalidRate ?? 0.01) *
              between(`${def.id}:${player.seat}:inv`, 0.5, 1.5),
          ),
      timeouts: isBot ? 0 : intBetween(`${def.id}:${player.seat}:timeouts`, 0, 1),
    };
  });
};

/** Summary of a mock game after `events` (all of them for finished games). */
export const summarize = (
  def: MockGameDef,
  config: GameConfig,
  events: ReadonlyArray<GameEvent>,
  isLive: boolean,
): GameSummary => {
  const state = replay(config, events);
  const isFinished = !isLive && state.status === "finished";
  const players = config.seats.length;

  return {
    id: def.id,
    runId: def.runId,
    seed: config.seed,
    status: isFinished ? "finished" : "running",
    playersCount: Option.getOrElse(decodePlayers(players), (): PlayersCount => 4),
    startedAt: def.startedAt,
    finishedAt: isFinished ? addMinutes(def.startedAt, Math.round(state.control.turn * 0.9)) : null,
    turn: state.control.turn,
    round: state.control.gameRound,
    endReason: isFinished ? state.endReason : null,
    winnerSeat: isFinished ? state.winner : null,
    seats: seatSummaries(def, state, isFinished),
  };
};

const summaryCache = new Map<string, GameSummary>();

/** Summary of a finished mock game (memoized). */
export const finishedSummary = (def: MockGameDef): GameSummary => {
  const cached = summaryCache.get(def.id);

  if (cached !== undefined) return cached;

  const game = loadGame(def);
  const summary = summarize(def, game.config, game.events, false);

  summaryCache.set(def.id, summary);

  return summary;
};
