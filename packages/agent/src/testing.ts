/**
 * Scripted models for tests and offline simulations, on pi-ai's faux provider (no network).
 * `@mb/agent/testing`.
 */
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { calculateCost, createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type FauxResponseStep };

export interface ScriptedModel {
  readonly faux: FauxProviderHandle;
  readonly model: Model<Api>;
  /** Streams the scripted responses, priced at the model's cost like real providers. */
  readonly streamFn: StreamFn;
}

/** `$1` per input token and `$2` per output token, so costs are easy to check. */
export const scriptedModel = (responses: ReadonlyArray<FauxResponseStep>): ScriptedModel => {
  const faux = fauxProvider({
    models: [
      {
        id: "scripted-player",
        reasoning: true,
        cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });

  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([...responses]);

  const streamFn: StreamFn = (model, context, options) => {
    const stream = models.streamSimple(model, context, options);
    const result = stream.result.bind(stream);
    stream.result = async () => {
      const message = await result();
      calculateCost(model, message.usage);

      return message;
    };

    return stream;
  };

  return { faux, model: faux.getModel(), streamFn };
};

/** An assistant turn that calls the given tools. */
export const toolTurn = (...calls: ReadonlyArray<ReturnType<typeof fauxToolCall>>) =>
  fauxAssistantMessage([...calls], { stopReason: "toolUse" });
