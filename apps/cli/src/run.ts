/**
 * `mb run create <config.json>` / `mb run status <id>`: remote runs through the Worker API
 * (`BENCH_URL`, and `BENCH_API_KEY` for creation; SPEC §10).
 */
import { readFileSync } from "node:fs";

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

const create = async (path: string): Promise<number> => {
  const config = decodeConfig(readFileSync(path, "utf8"));

  const response = await fetch(`${baseUrl()}/api/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env("BENCH_API_KEY")}`,
      "content-type": "application/json",
    },
    body: encodeConfig(config),
  });

  if (!response.ok) throw await failure(response);

  const { run } = decodeCreated(await response.text());

  console.log(`Created run ${run.id}: ${run.gamesTotal} games, budget $${run.budgetUsd}.`);
  console.log(`Follow it with: mb run status ${run.id}`);

  return 0;
};

const status = async (id: string): Promise<number> => {
  const response = await fetch(`${baseUrl()}/api/runs/${encodeURIComponent(id)}`);

  if (!response.ok) throw await failure(response);

  printDetail(decodeDetail(await response.text()));

  return 0;
};

export const runCommand: CliCommand = {
  name: "run",
  summary: "Create a run on the deployed bench, or show its progress (BENCH_URL, BENCH_API_KEY).",
  usage: "mb run create <config.json> | mb run status <run id>",
  run: async (args) => {
    const [action, target] = args;

    if (action === "create" && target !== undefined) return create(target);

    if (action === "status" && target !== undefined) return status(target);

    throw new Error("usage: mb run create <config.json> | mb run status <run id>");
  },
};
