/** Root Commands: navigation, the live-games poll, and saving preferences. */
import { GamesResponse } from "@mb/api";
import { Duration, Effect, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { load, pushUrl } from "foldkit/navigation";

import { BrowserKeyValueStore } from "@effect/platform-browser";

import { liveGames, withApi } from "./api/api.ts";
import { Message } from "./message.ts";
import { Theme } from "./model.ts";

export const THEME_STORAGE_KEY = "mb.theme";

export const API_KEY_STORAGE_KEY = "mb.apiKey";

const LIVE_POLL_INTERVAL = Duration.seconds(20);

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

export const SaveTheme = Command.define("SaveTheme", {
  args: { theme: Theme },
  messages: [Message.CompletedSaveTheme],
  execute: ({ theme }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(THEME_STORAGE_KEY, theme);
    }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedSaveTheme()),
      Effect.provide(BrowserKeyValueStore.layerLocalStorage),
    ),
});
