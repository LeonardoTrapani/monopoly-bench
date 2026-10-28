/**
 * `mb run create <config.json>` / `mb run status <id>`: remote runs through the Worker API
 * (`BENCH_URL`; creation needs `BENCH_API_KEY`, or `--openrouter-key-env VAR` to pay with your
 * own OpenRouter key; SPEC §10).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { CreateRunResponse, ErrorResponse, RunConfig, RunDetail } from "@mb/api";
import { Option, Schema } from "effect";

import { table } from "./cli.ts";

import type { CliCommand } from "./cli.ts";

const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(RunConfig));

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(RunConfig));

const decodeCreated = Schema.decodeUnknownSync(Schema.fromJsonString(CreateRunResponse));

const decodeDetail = Schema.decodeUnknownSync(Schema.fromJsonString(RunDetail));

const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse));

const env = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value.length === 0) throw new Error(`${name} is not set`);

  return value;
};

const baseUrl = (): string => env("BENCH_URL").replace(/\/+$/, "");

const failure = async (response: Response): Promise<Error> => {
  const text = await response.text();

  const message = Option.match(decodeError(text), {
    onSome: (parsed) => parsed.error,
    onNone: () => text,
  });

  return new Error(`${response.status} ${response.statusText}: ${message}`);
};

const printDetail = (detail: RunDetail): void => {
  const { run } = detail;

  console.log(
    `Run ${run.id}${run.name === null ? "" : ` (${run.name})`}: ${run.status}, ${run.gamesFinished}/${run.gamesTotal} games done, ${run.gamesRunning} running, $${run.spentUsd.toFixed(4)} of $${run.budgetUsd} spent.`,
  );

  if (detail.games.length === 0) return;

  console.log(
    table([
      ["game", "status", "turn", "end", "winner", "seats (rank)"],
      ...detail.games.map((game) => [
        game.id,
        game.status,
        String(game.turn),
        game.endReason ?? "-",
        game.winnerSeat ?? "-",
        game.seats
          .map(
            (seat) =>
              `${seat.seat} ${seat.label}${seat.finalRank === null ? "" : ` #${seat.finalRank}`}`,
          )
          .join(", "),
      ]),
    ]),
  );
};

/**
 * Who pays: the bench (`BENCH_API_KEY` bearer) or, with `--openrouter-key-env VAR`, the
 * OpenRouter key in `$VAR`, sent once in `x-openrouter-key` (no bench key needed).
 */
export const createHeaders = (ownKeyEnv: string | undefined) =>
  ownKeyEnv === undefined
    ? { authorization: `Bearer ${env("BENCH_API_KEY")}`, "content-type": "application/json" }
    : { "x-openrouter-key": env(ownKeyEnv), "content-type": "application/json" };

const create = async (path: string, ownKeyEnv: string | undefined): Promise<number> => {
  const config = decodeConfig(readFileSync(path, "utf8"));

  const response = await fetch(`${baseUrl()}/api/runs`, {
    method: "POST",
    headers: createHeaders(ownKeyEnv),
    body: encodeConfig(config),
  });

  if (!response.ok) throw await failure(response);

  const { run, cancelToken } = decodeCreated(await response.text());

  console.log(
    `Created run ${run.id}: ${run.gamesTotal} games, budget $${run.budgetUsd}, paid by ${run.funding === "ownKey" ? "your OpenRouter key" : "the bench"}.`,
  );
  console.log(`Follow it with: mb run status ${run.id}`);

  if (cancelToken !== null) {
    console.log(`Cancel token (shown only now, keep it): ${cancelToken}`);
    console.log(
      `Cancel with: curl -X POST ${baseUrl()}/api/runs/${run.id}/cancel -H 'x-run-token: ${cancelToken}'`,
    );
  }

  return 0;
};

const USAGE = "mb run create <config.json> [--openrouter-key-env VAR] | mb run status <run id>";

const status = async (id: string): Promise<number> => {
  const response = await fetch(`${baseUrl()}/api/runs/${encodeURIComponent(id)}`);

  if (!response.ok) throw await failure(response);

  printDetail(decodeDetail(await response.text()));

  return 0;
};

export const runCommand: CliCommand = {
  name: "run",
  summary:
    "Create a run on the deployed bench (BENCH_API_KEY, or your own OpenRouter key), or show its progress (BENCH_URL).",
  usage: USAGE,
  run: async (args) => {
    const { values, positionals } = parseArgs({
      args: [...args],
      options: { "openrouter-key-env": { type: "string" } },
      strict: true,
      allowPositionals: true,
    });

    const [action, target] = positionals;

    if (action === "create" && target !== undefined) {
      return create(target, values["openrouter-key-env"]);
    }

    if (action === "status" && target !== undefined) return status(target);

    throw new Error(`usage: ${USAGE}`);
  },
};
