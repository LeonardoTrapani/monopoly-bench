import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Update, type Runtime } from "foldkit";
import type { Url } from "foldkit/url";

import { BrowserKeyValueStore } from "@effect/platform-browser";

import type { Api } from "./api/api.ts";
import { API_KEY_STORAGE_KEY, FetchLiveGames, THEME_STORAGE_KEY } from "./command.ts";
import { Message } from "./message.ts";
import { Flags, LiveGamesAsyncData, Page, Theme, type Model } from "./model.ts";
import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";
import { AppRoute, urlToAppRoute } from "./route.ts";

const decodeTheme = Schema.decodeUnknownOption(Theme);

/** Reads saved preferences from localStorage (theme, API key). */
export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  const theme = Option.flatMap(
    Option.fromNullishOr(yield* store.get(THEME_STORAGE_KEY)),
    decodeTheme,
  );

  const apiKey = Option.fromNullishOr(yield* store.get(API_KEY_STORAGE_KEY));

  return Flags.make({
    theme: Option.getOrElse(theme, (): Theme => "Light"),
    apiKey: Option.getOrElse(apiKey, () => ""),
  });
}).pipe(
  Effect.catch(() => Effect.succeed(Flags.make({ theme: "Light", apiKey: "" }))),
  Effect.provide(BrowserKeyValueStore.layerLocalStorage),
);

type PageInit = Update.Return<Page, Message, Api>;

/** The page state (and its initial Commands) for a route. */
export const initPage = (route: AppRoute, apiKey: string): PageInit =>
  AppRoute.match<PageInit>(route, {
    Home: () =>
      Update.foldChildInit(Home.init(), {
        toParentModel: (home) => Page.Home({ home }),
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    Games: () =>
      Update.foldChildInit(Games.init(), {
        toParentModel: (games) => Page.Games({ games }),
        toParentMessage: (message) => Message.GotGamesMessage({ message }),
      }),
    Game: ({ gameId }) =>
      Update.foldChildInit(Game.init(gameId), {
        toParentModel: (game) => Page.Game({ game }),
        toParentMessage: (message) => Message.GotGameMessage({ message }),
      }),
    Competitor: ({ competitorId }) =>
      Update.foldChildInit(Competitor.init(competitorId), {
        toParentModel: (competitor) => Page.Competitor({ competitor }),
        toParentMessage: (message) => Message.GotCompetitorMessage({ message }),
      }),
    Runs: () =>
      Update.foldChildInit(Runs.init(), {
        toParentModel: (runs) => Page.Runs({ runs }),
        toParentMessage: (message) => Message.GotRunsMessage({ message }),
      }),
    Run: ({ runId }) =>
      Update.foldChildInit(Run.init(runId), {
        toParentModel: (run) => Page.Run({ run }),
        toParentMessage: (message) => Message.GotRunMessage({ message }),
      }),
    NewRun: () =>
      Update.foldChildInit(NewRun.init(apiKey), {
        toParentModel: (newRun) => Page.NewRun({ newRun }),
        toParentMessage: (message) => Message.GotNewRunMessage({ message }),
      }),
    About: () => ({ model: Page.About() }),
    NotFound: ({ path }) => ({ model: Page.NotFound({ path }) }),
  });

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Api> = (
  initialFlags,
  url: Url,
) => {
  const route = urlToAppRoute(url);
  const page = initPage(route, initialFlags.apiKey);

  return {
    model: {
      route,
      page: page.model,
      theme: initialFlags.theme,
      apiKey: initialFlags.apiKey,
      liveGames: LiveGamesAsyncData.Loading(),
    },
    commands: [...(page.commands ?? []), FetchLiveGames()],
  };
};
