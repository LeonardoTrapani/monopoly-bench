import { GamesResponse } from "@mb/api";
import { Option, Record, Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";
import { AppRoute } from "./route.ts";

/** The state of the page on screen; each route owns its own Submodel. */
export const Page = defineTaggedUnion({
  Home: { home: Home.Model },
  Games: { games: Games.Model },
  Game: { game: Game.Model },
  Competitor: { competitor: Competitor.Model },
  Runs: { runs: Runs.Model },
  Run: { run: Run.Model },
  NewRun: { newRun: NewRun.Model },
  About: {},
  NotFound: { path: Schema.String },
});

export type Page = typeof Page.Type;

/** Run id → the cancel token `POST /api/runs` returned for an own-key run. */
export const RunTokens = Schema.Record(Schema.String, Schema.String);

export type RunTokens = typeof RunTokens.Type;

export const LiveGamesAsyncData = AsyncData.Schema(GamesResponse, Schema.String);

export const Model = Schema.Struct({
  route: AppRoute,
  page: Page,
  /** Bench API key for starting and cancelling server-funded runs (kept in localStorage). */
  apiKey: Schema.String,
  /** Cancel tokens of own-key runs started in this browser, by run id (kept in localStorage). */
  runTokens: RunTokens,
  /** Running games, polled for the header badge and the home page strip. */
  liveGames: LiveGamesAsyncData.schema,
});

export type Model = typeof Model.Type;

export const Flags = Schema.Struct({ apiKey: Schema.String, runTokens: RunTokens });

export type Flags = typeof Flags.Type;

/** What the run page can cancel with: this browser's cancel token for the run, or the bench key. */
export const runCredentials = (model: Model): Run.Credentials => ({
  runToken: AppRoute.matchOrElse(
    model.route,
    { Run: ({ runId }) => Record.get(model.runTokens, runId) },
    () => Option.none(),
  ),
  apiKey: model.apiKey,
});
