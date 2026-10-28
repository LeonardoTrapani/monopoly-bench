/**
 * The failure of a call that leaves the object: D1, R2, another Durable Object or OpenRouter.
 * Hosts only log it, retry later or pass it on to their caller, so one error type covers every
 * port; `operation` names the call and `cause` keeps the original failure.
 */
import { Effect, Schema } from "effect";

export class UpstreamError extends Schema.TaggedError<UpstreamError>()("UpstreamError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Turn any failure of `effect` into an `UpstreamError` for `operation`. */
export const upstream =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, UpstreamError, R> =>
    effect.pipe(Effect.mapError((cause) => new UpstreamError({ operation, cause })));
