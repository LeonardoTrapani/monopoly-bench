/** Token and cost accounting of model responses (SPEC.md §6.4). */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { WakeUsage } from "@mb/api";
import { Option, Schema } from "effect";

export const EMPTY_USAGE: WakeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
};

/** Input counts every prompt token: fresh, read from the cache and written to it. */
export const addResponseUsage = (total: WakeUsage, message: AssistantMessage): WakeUsage => ({
  inputTokens:
    total.inputTokens + message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
  outputTokens: total.outputTokens + message.usage.output,
  reasoningTokens: total.reasoningTokens + (message.usage.reasoning ?? 0),
  costUsd: total.costUsd + message.usage.cost.total,
});

export const sumUsage = (a: WakeUsage, b: WakeUsage): WakeUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  costUsd: a.costUsd + b.costUsd,
});

/** The `usage.cost` OpenRouter puts on the last chunk of a response: what it charged, in USD. */
const ReportedCostChunk = Schema.fromJsonString(
  Schema.Struct({
    usage: Schema.Struct({
      cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
);

const decodeReportedCostChunk = Schema.decodeUnknownOption(ReportedCostChunk);

/** The charge carried by one server-sent-events line (`data: {…}`), if any. */
const costOfLine = (line: string): Option.Option<number> =>
  line.startsWith("data:") && line.includes('"cost"')
    ? Option.map(decodeReportedCostChunk(line.slice("data:".length)), (chunk) => chunk.usage.cost)
    : Option.none();

/** The response with its body passed through unchanged, reporting every charge it carries. */
const tapReportedCost = (response: Response, report: (cost: number) => void): Response => {
  if (response.body === null) return response;

  const decoder = new TextDecoder();
  let partialLine = "";

  const scan = (text: string): void => {
    const lines = `${partialLine}${text}`.split("\n");
    partialLine = lines.pop() ?? "";

    for (const line of lines) {
      const cost = costOfLine(line);

      if (Option.isSome(cost)) report(cost.value);
    }
  };

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        scan(decoder.decode(chunk, { stream: true }));
      },
      flush: () => scan(`${decoder.decode()}\n`),
    }),
  );

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/** The message with OpenRouter's charge as its total cost, when OpenRouter reported one. */
const bookReportedCost = (
  message: AssistantMessage,
  reported: Option.Option<number>,
): AssistantMessage =>
  Option.match(reported, {
    onNone: () => message,
    onSome: (total) => ({
      ...message,
      usage: { ...message.usage, cost: { ...message.usage.cost, total } },
    }),
  });

/**
 * Books what OpenRouter charged for each response (`usage.cost` on its last chunk) instead of
 * tokens × listed price: routers such as `typesafe/jev-router` list no price ("-1") because
 * they bill whichever model they pick, and the charge also covers rates a listing leaves out.
 * A response without a reported charge (another provider, a test model) keeps pi-ai's cost.
 * The agent loop reads the final message from `result()`, so that is where the charge lands.
 */
export const withReportedCost =
  (streamFn: StreamFn): StreamFn =>
  async (model, context, options) => {
    let reported = Option.none<number>();
    const send = options?.fetch ?? fetch;

    const stream = await streamFn(model, context, {
      ...options,
      fetch: async (input, init) =>
        tapReportedCost(await send(input, init), (cost) => {
          reported = Option.some(cost);
        }),
    });

    const result = stream.result.bind(stream);
    stream.result = async () => bookReportedCost(await result(), reported);

    return stream;
  };
