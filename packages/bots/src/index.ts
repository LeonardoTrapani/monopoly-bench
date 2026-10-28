/**
 * `@mb/bots`: scripted Monopoly policies used for tests, simulations and leaderboard
 * baselines. A policy maps (`PlayerView`, `DecisionRequest`) to the commands to submit
 * for that wake, ending with a terminal command. Both policies are deterministic given
 * their seed.
 */
import { heuristicBot } from "./heuristic.ts";
import { randomBot } from "./random.ts";

import type { Bot } from "./common.ts";

export type { Bot } from "./common.ts";

export { heuristicBot } from "./heuristic.ts";

export { randomBot } from "./random.ts";

/** Same literals as `@mb/api` `BotPolicy`. */
export const BOT_POLICIES = ["random", "heuristic"] as const;

export type BotPolicy = (typeof BOT_POLICIES)[number];

export const isBotPolicy = (value: string): value is BotPolicy =>
  BOT_POLICIES.some((policy) => policy === value);

/** Creates the bot for `policy`, deterministic for a given `seed` (e.g. `<gameSeed>:<seat>`). */
export const createBot = (policy: BotPolicy, seed: string): Bot =>
  policy === "random" ? randomBot(seed) : heuristicBot(seed);
