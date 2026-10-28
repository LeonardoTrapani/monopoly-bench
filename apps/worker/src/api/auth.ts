/**
 * Authentication of the protected routes (SPEC.md §7.2): the bench owner's bearer key, and the
 * cancel tokens of own-key runs (random, returned once, stored only as SHA-256).
 */

import { Effect } from "effect";

const encoder = new TextEncoder();

const sha256 = (text: string): Effect.Effect<Uint8Array> =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", encoder.encode(text))).pipe(
    Effect.map((digest) => new Uint8Array(digest)),
  );

/**
 * Constant-time string comparison: both sides are hashed to 32 bytes first, so neither the
 * length nor the position of the first difference leaks through timing.
 */
export const constantTimeEqual = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.all([sha256(a), sha256(b)]).pipe(
    Effect.map(([left, right]) => {
      let difference = 0;

      for (let index = 0; index < left.length; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
      }

      return difference === 0;
    }),
  );

export const bearerToken = (authorization: string | null): string | null => {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? "");

  return match?.[1] ?? null;
};

/** With no key configured the protected routes stay closed. */
export const isAuthorized = (
  authorization: string | null,
  apiKey: string,
): Effect.Effect<boolean> => {
  const token = bearerToken(authorization);

  if (apiKey.length === 0 || token === null) return Effect.succeed(false);

  return constantTimeEqual(token, apiKey);
};

/** Lowercase hex SHA-256 of a UTF-8 string: how a run stores its cancel token. */
export const sha256Hex = (text: string): Effect.Effect<string> =>
  sha256(text).pipe(
    Effect.map((digest) => [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
  );

/** 32 random bytes, base64url without padding (43 characters). */
export const newCancelToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
