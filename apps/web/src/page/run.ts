import { Schema } from "effect";
import { Submodel, type Update } from "foldkit";
import { defineMessageUnion } from "foldkit/message";

import type { Api } from "../api/api.ts";

export const Model = Schema.Struct({ id: Schema.String });

export type Model = typeof Model.Type;

export const Message = defineMessageUnion({ ClickedNothing: {} });

export type Message = typeof Message.Type;

export const init = (id: string): Update.Return<Model, Message, Api> => ({ model: { id } });

export const update = (model: Model, message: Message, _apiKey: string) =>
  Message.match<Update.Return<Model, Message, Api>>(message, { ClickedNothing: () => ({ model }) });

export const view = Submodel.defineView<Model, Message, Readonly<{ hasApiKey: boolean }>>(
  (model, _inputs, h) => h.div([], [model.id]),
);
