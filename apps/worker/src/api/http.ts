/** Response helpers: open CORS, JSON bodies encoded with the `@mb/api` schemas. */
import { ErrorResponse } from "@mb/api";
import { Schema } from "effect";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
} as const satisfies Readonly<Record<string, string>>;

export const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/** Encode `value` with `schema` (so the body has exactly the contract's shape) as JSON. */
export const json = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
  status = 200,
): Response =>
  new Response(Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });

export const errorJson = (status: number, error: string): Response =>
  json(ErrorResponse, { error }, status);

export const ndjson = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", ...CORS_HEADERS },
  });

/** A JSON body produced elsewhere with its own schema (e.g. the engine's `GameConfig`). */
export const jsonText = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });

export const preflight = (): Response => new Response(null, { status: 204, headers: CORS_HEADERS });
