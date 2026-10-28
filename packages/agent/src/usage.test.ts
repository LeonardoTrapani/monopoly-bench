import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vite-plus/test";

import { scriptedModel } from "./testing.ts";
import { withReportedCost } from "./usage.ts";

const COMPUTED_COST = 0.5;

/** The last chunk of an OpenRouter stream, with what it charged. */
const usageChunk = (cost: number): string =>
  `data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":6,"completion_tokens":12,"cost":${cost}}}\n\n`;

/** A response whose body arrives in the given pieces. */
const streamedResponse = (pieces: ReadonlyArray<string>): Response => {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

/**
 * A provider that reads the whole response through `options.fetch`, as pi-ai does, and answers
 * with a message priced at `COMPUTED_COST`.
 */
const providerReading = (): StreamFn => {
  const priced: AssistantMessage = fauxAssistantMessage([fauxText("ok")]);
  priced.usage.cost.total = COMPUTED_COST;

  return async (_model, _context, options) => {
    const send = options?.fetch;

    if (send !== undefined)
      await (await send("https://openrouter.ai/api/v1/chat/completions")).text();

    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: priced });

    return stream;
  };
};

const finalMessage = async (response: Response): Promise<AssistantMessage> => {
  const { model } = scriptedModel([]);

  const stream = await withReportedCost(providerReading())(
    model,
    normalizeContext({ messages: [] }),
    { fetch: async () => response },
  );

  return stream.result();
};

describe("withReportedCost", () => {
  it("books the charge OpenRouter reports, even when a network chunk splits its line", async () => {
    const body = `data: {"id":"gen-1","choices":[{"delta":{"content":"ok"}}]}\n\n${usageChunk(0.0123)}data: [DONE]\n\n`;
    const split = body.indexOf('"cost"');

    const message = await finalMessage(streamedResponse([body.slice(0, split), body.slice(split)]));

    expect(message.usage.cost.total).toBe(0.0123);
    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("keeps the computed cost when the response reports no charge", async () => {
    const message = await finalMessage(
      streamedResponse([
        'data: {"id":"gen-1","usage":{"prompt_tokens":6}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    expect(message.usage.cost.total).toBe(COMPUTED_COST);
  });
});
