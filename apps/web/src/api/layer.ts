/**
 * Picks the API implementation once, at startup. The mock is a dynamic import behind a
 * build-time constant, so the default build does not contain it.
 */
import { Effect, Layer } from "effect";

import type { Api } from "./api.ts";
import { HttpApiLive } from "./http.ts";

export const isMockMode = import.meta.env.VITE_API_MODE === "mock";

export const ApiLive: Layer.Layer<Api> =
  import.meta.env.VITE_API_MODE === "mock"
    ? Layer.unwrap(
        Effect.promise(() => import("../mock/client.ts")).pipe(
          Effect.map((module) => module.MockApiLive),
        ),
      )
    : HttpApiLive(import.meta.env.VITE_API_BASE ?? "");
