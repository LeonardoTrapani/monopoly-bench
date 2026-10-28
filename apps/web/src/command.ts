/** Root Commands: navigation, the live-games poll, and saving run cancel tokens. */
import { GamesResponse } from "@mb/api";
import { Duration, Effect, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import * as Dom from "foldkit/dom";
import { load, pushUrl } from "foldkit/navigation";

import { BrowserKeyValueStore } from "@effect/platform-browser";

import { liveGames, withApi } from "./api/api.ts";
import { Message } from "./message.ts";
import { RunTokens } from "./model.ts";

export const API_KEY_STORAGE_KEY = "mb.apiKey";

export const RUN_TOKENS_STORAGE_KEY = "mb.runTokens";

/** Where the removed dark theme kept its preference; cleared at startup. */
export const LEGACY_THEME_STORAGE_KEY = "mb.theme";

const LIVE_POLL_INTERVAL = Duration.seconds(20);

const encodeRunTokens = Schema.encodeSync(Schema.fromJsonString(RunTokens));

export const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

export const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

/** Scrolls to the element named by the URL fragment (`/about#costs`) once the page is drawn. */
export const ScrollToFragment = Command.define("ScrollToFragment", {
  args: { id: Schema.String },
  messages: [Message.CompletedScrollToFragment],
  execute: ({ id }) =>
    Dom.scrollIntoViewAfterPaint(`#${CSS.escape(id)}`, { block: "start" }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedScrollToFragment()),
    ),
});

export const FetchLiveGames = Command.define("FetchLiveGames", {
  messages: [Message.SucceededFetchLiveGames, Message.FailedFetchLiveGames],
  execute: withApi((api) => api.games(liveGames)).pipe(
    Effect.map((response: GamesResponse) => Message.SucceededFetchLiveGames({ response })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchLiveGames({ error }))),
  ),
});

export const WaitBeforeLivePoll = Command.define("WaitBeforeLivePoll", {
  messages: [Message.CompletedWaitBeforeLivePoll],
  execute: Effect.sleep(LIVE_POLL_INTERVAL).pipe(Effect.as(Message.CompletedWaitBeforeLivePoll())),
});

/** Persists the cancel tokens of own-key runs, so the Cancel button works after a reload. */
export const SaveRunTokens = Command.define("SaveRunTokens", {
  args: { runTokens: RunTokens },
  messages: [Message.CompletedSaveRunTokens],
  execute: ({ runTokens }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(RUN_TOKENS_STORAGE_KEY, encodeRunTokens(runTokens));
    }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedSaveRunTokens()),
      Effect.provide(BrowserKeyValueStore.layerLocalStorage),
    ),
});
