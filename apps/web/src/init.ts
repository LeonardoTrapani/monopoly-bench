import { Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Update, type Runtime } from "foldkit";
import type { Url } from "foldkit/url";

import { BrowserKeyValueStore } from "@effect/platform-browser";

import type { Api } from "./api/api.ts";
import {
  API_KEY_STORAGE_KEY,
  FetchLiveGames,
  LEGACY_THEME_STORAGE_KEY,
  RUN_TOKENS_STORAGE_KEY,
  ScrollToFragment,
} from "./command.ts";
import { Message } from "./message.ts";
import { Flags, LiveGamesAsyncData, Page, RunTokens, type Model } from "./model.ts";
import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";
import { AppRoute, decodeUriPart, urlToAppRoute } from "./route.ts";

const decodeRunTokens = Schema.decodeUnknownOption(Schema.fromJsonString(RunTokens));

/**
 * Reads what this browser keeps in localStorage: the bench API key and the cancel tokens of
 * own-key runs. Also drops the preference of the removed dark theme.
 */
export const flags: Effect.Effect<Flags> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;

  yield* store.remove(LEGACY_THEME_STORAGE_KEY);

  const apiKey = Option.fromNullishOr(yield* store.get(API_KEY_STORAGE_KEY));

  const runTokens = Option.flatMap(
    Option.fromNullishOr(yield* store.get(RUN_TOKENS_STORAGE_KEY)),
    decodeRunTokens,
  );

  return Flags.make({
    apiKey: Option.getOrElse(apiKey, () => ""),
    runTokens: Option.getOrElse(runTokens, () => ({})),
  });
}).pipe(
  Effect.catch(() => Effect.succeed(Flags.make({ apiKey: "", runTokens: {} }))),
  Effect.provide(BrowserKeyValueStore.layerLocalStorage),
);

/** Scrolls to the URL fragment, if any, once the page is drawn. */
export const fragmentCommands = (url: Url) =>
  Option.match(url.hash, {
    onNone: () => [],
    onSome: (id) => [ScrollToFragment({ id: decodeUriPart(id) })],
  });

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
      apiKey: initialFlags.apiKey,
      runTokens: initialFlags.runTokens,
      liveGames: LiveGamesAsyncData.Loading(),
    },
    commands: [...(page.commands ?? []), FetchLiveGames(), ...fragmentCommands(url)],
  };
};
