/**
 * Checks a creator's own OpenRouter key before an own-key run starts (SPEC.md §7.2), with
 * OpenRouter's `GET /api/v1/key` (the key's own limits; no model call, no cost). The key is
 * only sent to OpenRouter; nothing here logs it or puts it in a message.
 */
import { OPENROUTER_BASE_URL } from "@mb/agent";
import { Option, Schema } from "effect";

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

export const checkOpenRouterKey = async (key: string, fetcher: typeof fetch): Promise<KeyCheck> => {
  let response: Response;

  try {
    response = await fetcher(OPENROUTER_KEY_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
  } catch {
    return { status: "unavailable", reason: "OpenRouter could not be reached" };
  }

  if (response.status === 401 || response.status === 403) return { status: "rejected" };

  if (!response.ok) {
    return { status: "unavailable", reason: `OpenRouter answered ${response.status}` };
  }

  // A 200 means the key works; a body we cannot read only loses the limit.
  const info = decodeKeyInfo(await response.text());

  return {
    status: "valid",
    limitRemainingUsd: Option.match(info, {
      onSome: (body) => body.data.limit_remaining ?? null,
      onNone: () => null,
    }),
  };
};
