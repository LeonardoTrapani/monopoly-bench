import { Option } from "effect";
import { Subscription } from "foldkit";

import type { Api } from "./api/api.ts";
import { Message } from "./message.ts";
import { Page, type Model } from "./model.ts";
import * as Game from "./page/game/index.ts";

/** The game viewer's live feed and playback clock, active only on the game page. */
const gameSubscriptions = Subscription.lift(Game.subscriptions)<Model, Message>({
  read: (model) =>
    Page.matchOrElse(model.page, { Game: ({ game }) => Option.some(game) }, () => Option.none()),
  toParentMessage: (message) => Message.GotGameMessage({ message }),
});

export const subscriptions: Subscription.Subscriptions<Model, Message, Api> = gameSubscriptions;
