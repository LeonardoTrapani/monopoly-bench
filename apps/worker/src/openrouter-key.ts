/**
 * Checks a creator's own OpenRouter key before an own-key run starts (SPEC.md §7.2), with
 * OpenRouter's `GET /api/v1/key` (the key's own limits; no model call, no cost). The key is
 * only sent to OpenRouter; nothing here logs it or puts it in a message.
 */
import { OPENROUTER_BASE_URL } from "@mb/agent";
import { Effect, Option, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";

export const OPENROUTER_KEY_URL = `${OPENROUTER_BASE_URL}/key`;

export type KeyCheck =
  /** `limitRemainingUsd` is null when the key has no credit limit. */
  | { readonly status: "valid"; readonly limitRemainingUsd: number | null }
  /** OpenRouter refused the key (401/403). */
  | { readonly status: "rejected" }
  /** OpenRouter could not be asked (network error, 429, 5xx). */
  | { readonly status: "unavailable"; readonly reason: string };

const KeyInfo = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      limit_remaining: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  }),
);

const decodeKeyInfo = Schema.decodeUnknownOption(KeyInfo);

export const checkOpenRouterKey = (
  key: string,
): Effect.Effect<KeyCheck, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const response = yield* client
      .get(OPENROUTER_KEY_URL, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      })
      .pipe(Effect.option);

    if (Option.isNone(response)) {
      return { status: "unavailable", reason: "OpenRouter could not be reached" } as const;
    }

    const { status } = response.value;

    if (status === 401 || status === 403) return { status: "rejected" } as const;

    if (status < 200 || status >= 300) {
      return { status: "unavailable", reason: `OpenRouter answered ${status}` } as const;
    }

    // A 200 means the key works; a body we cannot read only loses the limit.
    const info = decodeKeyInfo(yield* response.value.text.pipe(Effect.orElseSucceed(() => "")));

    return {
      status: "valid",
      limitRemainingUsd: Option.match(info, {
        onSome: (body) => body.data.limit_remaining ?? null,
        onNone: () => null,
      }),
    } as const;
  });
