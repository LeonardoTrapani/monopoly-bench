/** Helpers for tests of Effect code: fake ports from plain functions, and running effects. */
import { Effect, Logger } from "effect";

import { UpstreamError } from "../errors.ts";

/** A logger that appends every log line (its message parts, errors with their stack) to `lines`. */
export const captureLogs = (lines: Array<string>) =>
  Logger.make(({ message }) => {
    const parts = Array.isArray(message) ? message : [message];

    lines.push(
      parts
        .map((part) => (part instanceof Error ? (part.stack ?? part.message) : String(part)))
        .join(" "),
    );
  });

/** Run `effect` as a Promise; log lines go to `logs` when given, nowhere otherwise. */
export const run = <A, E>(effect: Effect.Effect<A, E>, logs?: Array<string>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Logger.layer(logs === undefined ? [] : [captureLogs(logs)]))),
  );

/** A port backed by a plain (possibly async) function: what it throws is the port's failure. */
export const port =
  <Args extends ReadonlyArray<unknown>, A>(body: (...args: Args) => A | Promise<A>) =>
  (...args: Args): Effect.Effect<A, UpstreamError> =>
    Effect.tryPromise({
      try: async () => body(...args),
      catch: (cause) => new UpstreamError({ operation: "test port", cause }),
    });

/** A port that does nothing. */
export const noop = (): Effect.Effect<void> => Effect.void;
