/**
 * `mb sim` with LLM seats: plays one game in-process with the Pi harness on OpenRouter
 * (`OPENROUTER_API_KEY`), under a hard budget, and prints per-seat cost.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  listingsOfModelList,
  OPENROUTER_MODELS_URL,
  type OpenRouterListing,
  openRouterModels,
  resolveOpenRouterModel,
} from "@mb/agent";
import { WakeTranscript } from "@mb/api";
import { type BotPolicy, BOT_POLICIES } from "@mb/bots";
import { createConfig } from "@mb/engine";
import { Schema } from "effect";

import { intFlag, type ParsedFlags, table } from "./cli.ts";
import { type MixedGameResult, runMixedGame, type SeatPlan } from "./llm-game.ts";
import { llmPlans, parseReasoning, parseSeatList, seatConfigs } from "./players.ts";
import { ruleOverrides, writeGameFiles } from "./sim.ts";

const encodeTranscript = Schema.encodeSync(Schema.fromJsonString(WakeTranscript));

/** Prices from OpenRouter's public model list (no key); empty when unreachable. */
const fetchListings = async (): Promise<ReadonlyMap<string, OpenRouterListing>> => {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: "application/json" },
    });

    if (!response.ok) return new Map();

    return new Map(
      listingsOfModelList(await response.text()).map((entry) => [entry.id, entry] as const),
    );
  } catch {
    return new Map();
  }
};

const usd = (value: number): string => `$${value.toFixed(4)}`;

const printLlmResult = (result: MixedGameResult, ms: number): void => {
  const { game } = result;
  const labels = new Map(game.config.seats.map((seat) => [seat.seat, seat.label]));
  const llm = new Map(result.llm.map((entry) => [entry.seat, entry]));
  const bots = new Map(game.stats.map((entry) => [entry.seat, entry]));

  console.log(
    `Game ${game.config.gameId} (seed ${game.config.seed}): ${game.state.endReason ?? "unfinished"} after ${game.rounds} rounds, ${game.turns} turns, ${game.events.length} events, ${Math.round(ms / 1000)} s.`,
  );
  console.log(
    table([
      [
        "rank",
        "seat",
        "player",
        "net worth",
        "cash",
        "wakes",
        "tool calls",
        "invalid",
        "timeouts",
        "tokens in/out",
        "cost",
      ],
      ...game.standings.map((row) => {
        const seat = llm.get(row.seat);
        const bot = bots.get(row.seat);

        return [
          String(row.rank),
          row.seat,
          labels.get(row.seat) ?? row.seat,
          `$${row.netWorth}`,
          `$${row.cash}`,
          String(seat?.wakes ?? bot?.wakes ?? 0),
          seat === undefined ? "-" : String(seat.toolCalls),
          String(seat?.invalid ?? bot?.invalid ?? 0),
          String(seat?.timeouts ?? bot?.timeouts ?? 0),
          seat === undefined ? "-" : `${seat.inputTokens}/${seat.outputTokens}`,
          seat === undefined ? "-" : usd(seat.costUsd),
        ];
      }),
    ]),
  );
  console.log(
    `Spent ${usd(result.spentUsd)}${result.budgetExhausted ? " — budget reached, the game was aborted" : ""}.`,
  );
};

/** `mb sim` when the seats include LLMs. */
export const runLlmSim = async (flags: ParsedFlags): Promise<number> => {
  const options = {
    reasoning: parseReasoning(flags.strings.get("reasoning")),
    maxOutputTokens: flags.strings.has("max-output-tokens")
      ? intFlag(flags, "max-output-tokens", 0)
      : undefined,
  };

  const seatsFlag = flags.strings.get("seats");
  const llmFlag = flags.strings.get("llm");
  const botsFlag = flags.strings.get("bots");

  const bots: ReadonlyArray<BotPolicy> =
    botsFlag === undefined
      ? ["heuristic"]
      : parseSeatList(botsFlag, options).flatMap((plan) =>
          plan.kind === "bot" ? [plan.policy] : [],
        );

  const plans: ReadonlyArray<SeatPlan> =
    seatsFlag !== undefined
      ? parseSeatList(seatsFlag, options)
      : [
          ...bots.map((policy): SeatPlan => ({ kind: "bot", policy })),
          ...llmPlans(llmFlag ?? "", options),
        ];

  if (plans.length < 2 || plans.length > 6) {
    throw new Error(`need 2 to 6 seats, got ${plans.length} (bots: ${BOT_POLICIES.join(", ")})`);
  }

  const apiKey = process.env["OPENROUTER_API_KEY"];

  if (plans.some((plan) => plan.kind === "llm") && (apiKey === undefined || apiKey.length === 0)) {
    throw new Error("LLM seats need OPENROUTER_API_KEY in the environment");
  }

  const budgetRaw = flags.strings.get("budget-usd") ?? "0.50";
  const budgetUsd = Number(budgetRaw);

  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0)
    throw new Error(`--budget-usd must be positive, got "${budgetRaw}"`);

  const seed = flags.strings.get("seed") ?? "1";

  const config = createConfig({
    gameId: flags.strings.get("game-id") ?? `sim-llm-${plans.length}p-${seed}`,
    seed,
    seats: seatConfigs(plans),
    rules: ruleOverrides(flags.strings.get("max-rounds"), flags.strings.get("table-frequency")),
  });

  const models = openRouterModels();
  const listings = await fetchListings();
  const started = performance.now();

  console.log(
    `Playing ${config.seats.map((seat) => `${seat.seat} ${seat.label}`).join(", ")} (budget ${usd(budgetUsd)})…`,
  );

  const result = await runMixedGame({
    config,
    seats: plans,
    budgetUsd,
    verify: flags.booleans.has("verify"),
    models: (spec) => ({
      model: resolveOpenRouterModel(models, spec.model, listings.get(spec.model)),
      streamFn: models.streamSimple.bind(models),
      apiKey,
    }),
    onWake: (transcript, wake) => {
      console.log(
        `  ${transcript.seat} turn ${transcript.turn} ${transcript.frame} r${transcript.round}: ${wake.endReason}, ${wake.toolCalls.length} calls, ${usd(wake.usage.costUsd)}${wake.compaction?.compacted === true ? ", memory compacted" : ""}${wake.errorMessage === null ? "" : ` (${wake.errorMessage})`}`,
      );
    },
  });

  printLlmResult(result, performance.now() - started);

  if (!flags.booleans.has("no-out")) {
    const dir = flags.strings.get("out") ?? "out";
    const written = writeGameFiles(dir, result.game.config, result.game.events);
    const transcriptsPath = join(dir, `${result.game.config.gameId}.transcripts.jsonl`);

    writeFileSync(
      transcriptsPath,
      result.transcripts.map((entry) => `${encodeTranscript(entry)}\n`).join(""),
    );
    console.log(`Wrote ${[...written, transcriptsPath].join(", ")}.`);
  }

  return 0;
};
