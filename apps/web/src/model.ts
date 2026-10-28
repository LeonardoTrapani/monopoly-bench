import { GamesResponse } from "@mb/api";
import { Schema } from "effect";
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

export const Theme = Schema.Literals(["Light", "Dark"]);

export type Theme = typeof Theme.Type;

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

export const LiveGamesAsyncData = AsyncData.Schema(GamesResponse, Schema.String);

export const Model = Schema.Struct({
  route: AppRoute,
  page: Page,
  theme: Theme,
  /** Bench API key for starting and cancelling runs (kept in localStorage). */
  apiKey: Schema.String,
  /** Running games, polled for the header badge and the home page strip. */
  liveGames: LiveGamesAsyncData.schema,
});

export type Model = typeof Model.Type;

export const Flags = Schema.Struct({ theme: Theme, apiKey: Schema.String });

export type Flags = typeof Flags.Type;
