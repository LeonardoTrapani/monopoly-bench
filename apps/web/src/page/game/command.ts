import { Duration, Effect, Schema } from "effect";
import { Command } from "foldkit";

import { withApi } from "../../api/api.ts";
import { Message } from "./message.ts";

const RECONNECT_DELAY = Duration.seconds(3);

export const FetchSummary = Command.define("FetchSummary", {
  args: { gameId: Schema.String },
  messages: [Message.SucceededFetchSummary, Message.FailedFetchSummary],
  execute: ({ gameId }) =>
    withApi((api) => api.game(gameId)).pipe(
      Effect.map((summary) => Message.SucceededFetchSummary({ summary })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchSummary({ error }))),
    ),
});

/** The engine config and the full event log, fetched together (both are needed to replay). */
export const FetchReplay = Command.define("FetchReplay", {
  args: { gameId: Schema.String },
  messages: [Message.SucceededFetchReplay, Message.FailedFetchReplay],
  execute: ({ gameId }) =>
    withApi((api) =>
      Effect.all([api.gameConfig(gameId), api.gameEvents(gameId, 0)], { concurrency: 2 }),
    ).pipe(
      Effect.map(([config, events]) => Message.SucceededFetchReplay({ config, events })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchReplay({ error }))),
    ),
});

export const FetchTranscripts = Command.define("FetchTranscripts", {
  args: { gameId: Schema.String },
  messages: [Message.SucceededFetchTranscripts, Message.FailedFetchTranscripts],
  execute: ({ gameId }) =>
    withApi((api) => api.transcripts(gameId)).pipe(
      Effect.map((transcripts) => Message.SucceededFetchTranscripts({ transcripts })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchTranscripts({ error }))),
    ),
});

/** Events after `since`, to fill a gap in the live feed. */
export const FetchEventsSince = Command.define("FetchEventsSince", {
  args: { gameId: Schema.String, since: Schema.Int },
  messages: [Message.SucceededFetchEventsSince, Message.FailedFetchEventsSince],
  execute: ({ gameId, since }) =>
    withApi((api) => api.gameEvents(gameId, since)).pipe(
      Effect.map((events) => Message.SucceededFetchEventsSince({ events })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchEventsSince({ error }))),
    ),
});

export const WaitBeforeReconnect = Command.define("WaitBeforeReconnect", {
  messages: [Message.CompletedWaitBeforeReconnect],
  execute: Effect.sleep(RECONNECT_DELAY).pipe(Effect.as(Message.CompletedWaitBeforeReconnect())),
});
