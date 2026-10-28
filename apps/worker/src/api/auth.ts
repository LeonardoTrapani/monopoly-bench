/**
 * Authentication of the protected routes (SPEC.md §7.2): the bench owner's bearer key, and the
 * cancel tokens of own-key runs (random, returned once, stored only as SHA-256).
 */

const encoder = new TextEncoder();

const sha256 = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/**
 * Constant-time string comparison: both sides are hashed to 32 bytes first, so neither the
 * length nor the position of the first difference leaks through timing.
 */
export const constantTimeEqual = async (a: string, b: string): Promise<boolean> => {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

export const bearerToken = (authorization: string | null): string | null => {
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? "");

  return match?.[1] ?? null;
};

/** With no key configured the protected routes stay closed. */
export const isAuthorized = async (
  authorization: string | null,
  apiKey: string,
): Promise<boolean> => {
  const token = bearerToken(authorization);

  if (apiKey.length === 0 || token === null) return false;

  return constantTimeEqual(token, apiKey);
};

/** Lowercase hex SHA-256 of a UTF-8 string: how a run stores its cancel token. */
export const sha256Hex = async (text: string): Promise<string> =>
  [...(await sha256(text))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** 32 random bytes, base64url without padding (43 characters). */
export const newCancelToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
