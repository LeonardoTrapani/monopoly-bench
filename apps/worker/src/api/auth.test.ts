import { describe, expect, it } from "vite-plus/test";

import { bearerToken, constantTimeEqual, isAuthorized } from "./auth.ts";

describe("auth", () => {
  it("parses bearer tokens", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer   abc123  ")).toBe("abc123");
    expect(bearerToken("Basic abc123")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it("compares in constant time over hashes", async () => {
    expect(await constantTimeEqual("secret", "secret")).toBe(true);
    expect(await constantTimeEqual("secret", "secreT")).toBe(false);
    expect(await constantTimeEqual("secret", "secret-and-more")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });

  it("authorizes only the configured key", async () => {
    expect(await isAuthorized("Bearer k-1", "k-1")).toBe(true);
    expect(await isAuthorized("Bearer k-2", "k-1")).toBe(false);
    expect(await isAuthorized(null, "k-1")).toBe(false);
  });

  it("keeps protected routes closed when no key is configured", async () => {
    expect(await isAuthorized("Bearer ", "")).toBe(false);
    expect(await isAuthorized("Bearer anything", "")).toBe(false);
  });
});
