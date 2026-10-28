/** Response helpers: open CORS, JSON bodies encoded with the `@mb/api` schemas. */
import { ErrorResponse } from "@mb/api";
import { Schema } from "effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-openrouter-key, x-run-token",
  "access-control-max-age": "86400",
} as const satisfies Readonly<Record<string, string>>;

const JSON_TYPE = "application/json; charset=utf-8";

/** Encode `value` with `schema` (so the body has exactly the contract's shape) as JSON. */
export const json = <S extends Schema.ConstraintEncoder<unknown>>(
  schema: S,
  value: S["Type"],
  status = 200,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(Schema.encodeUnknownSync(Schema.fromJsonString(schema))(value), {
    status,
    contentType: JSON_TYPE,
    headers: CORS_HEADERS,
  });

export const errorJson = (status: number, error: string): HttpServerResponse.HttpServerResponse =>
  json(ErrorResponse, { error }, status);

export const ndjson = (body: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, {
    contentType: "application/x-ndjson; charset=utf-8",
    headers: CORS_HEADERS,
  });

/** A JSON body produced elsewhere with its own schema (e.g. the engine's `GameConfig`). */
export const jsonText = (body: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { contentType: JSON_TYPE, headers: CORS_HEADERS });

export const preflight = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 204, headers: CORS_HEADERS });

export const noContent = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status: 204, headers: CORS_HEADERS });
