import { featuredModels } from "@mb/api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseSeatList } from "./players.ts";
import { createHeaders } from "./run.ts";

const saved = { bench: process.env["BENCH_API_KEY"], own: process.env["MB_TEST_OWN_KEY"] };

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  restore("BENCH_API_KEY", saved.bench);
  restore("MB_TEST_OWN_KEY", saved.own);
});

describe("mb run create", () => {
  it("sends the bench key by default", () => {
    process.env["BENCH_API_KEY"] = "bench";

    expect(createHeaders(undefined)).toEqual({
      authorization: "Bearer bench",
      "content-type": "application/json",
    });
  });

  it("sends only the OpenRouter key named by --openrouter-key-env, no bench key needed", () => {
    delete process.env["BENCH_API_KEY"];
    process.env["MB_TEST_OWN_KEY"] = "sk-or-v1-mine";

    expect(createHeaders("MB_TEST_OWN_KEY")).toEqual({
      "x-openrouter-key": "sk-or-v1-mine",
      "content-type": "application/json",
    });
    expect(() => createHeaders("MB_TEST_MISSING_KEY")).toThrow("MB_TEST_MISSING_KEY is not set");
  });
});

describe("mb sim seats", () => {
  it("suggests the featured models when an LLM seat names none", () => {
    expect(() =>
      parseSeatList("heuristic,llm:", { reasoning: undefined, maxOutputTokens: undefined }),
    ).toThrow(featuredModels[0] ?? "featured");
  });
});
