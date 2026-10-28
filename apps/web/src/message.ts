import { GamesResponse } from "@mb/api";
import { Schema } from "effect";
import { Url } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { UrlRequest } from "foldkit/navigation";

import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";

export const Message = defineMessageUnion({
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url.Url },
  ClickedToggleTheme: {},
  CompletedSaveTheme: {},
  SucceededFetchLiveGames: { response: GamesResponse },
  FailedFetchLiveGames: { error: Schema.String },
  CompletedWaitBeforeLivePoll: {},
  GotHomeMessage: { message: Home.Message },
  GotGamesMessage: { message: Games.Message },
  GotGameMessage: { message: Game.Message },
  GotCompetitorMessage: { message: Competitor.Message },
  GotRunsMessage: { message: Runs.Message },
  GotRunMessage: { message: Run.Message },
  GotNewRunMessage: { message: NewRun.Message },
});

export type Message = typeof Message.Type;
