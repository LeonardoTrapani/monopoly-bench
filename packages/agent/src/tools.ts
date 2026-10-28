/**
 * The tool set of SPEC.md §6.3. Every model gets exactly these names, descriptions and
 * parameter schemas, always all of them. Illegal calls come back as tool errors with the
 * engine's reason and count as invalid actions.
 *
 * The parameters mirror the engine's commands (`@mb/engine` `Command`, without `seat` and
 * `decisionId`, which the host adds); `commands.ts` maps them and `tools.test.ts` checks the
 * two stay aligned. Deeds may be named by printed name, slug or board position.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { GROUP_IDS, groupMembers, PROPERTIES, SEATS } from "@mb/engine";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export { GROUP_IDS, SEATS };

export const INSPECT_TOPICS = ["table", "deed", "player", "offers", "rules"] as const;

/** "Mediterranean Avenue (1), Baltic Avenue (3), …": every deed with its board position. */
export const DEED_LIST = PROPERTIES.map((info) => `${info.name} (${info.position})`).join(", ");

const GROUP_LIST = GROUP_IDS.map(
  (group) =>
    `${group}: ${groupMembers(group)
      .map((id) => PROPERTIES.find((info) => info.id === id)?.name ?? id)
      .join(", ")}`,
).join("; ");

const PropertyParam = Type.Union(
  [Type.String({ minLength: 1 }), Type.Integer({ minimum: 0, maximum: 39 })],
  {
    description: `A deed, by printed name, slug (e.g. "boardwalk") or board position. Deeds: ${DEED_LIST}.`,
  },
);

// Literal unions use pi-ai's `StringEnum` ({ type: "string", enum }): TypeBox's `Type.Enum`
// emits no `type`, which strict providers refuse (Moonshot: "type is not defined").
const GroupParam = StringEnum(GROUP_IDS, {
  description: `A color group, or railroads / utilities. ${GROUP_LIST}.`,
});

const OfferIdParam = Type.Integer({ minimum: 0, description: "Id of an offer (e.g. 3 for #3)." });

const CommentParam = Type.String({
  maxLength: 280,
  description: "Public, non-binding text attached to the offer (at most 280 characters).",
});

const AssetsParam = Type.Object(
  {
    cash: Type.Optional(Type.Integer({ minimum: 0, description: "Dollars." })),
    properties: Type.Optional(Type.Array(PropertyParam, { description: "Deeds." })),
    jailCards: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 2, description: "Get Out of Jail Free cards." }),
    ),
  },
  { description: "Cash, deeds and Get Out of Jail Free cards. Omitted fields mean none." },
);

const NoParams = Type.Object({});

export const toolParameters = {
  inspect: Type.Object({
    topic: StringEnum(INSPECT_TOPICS, {
      description:
        "table: the board and every player; deed: one title deed; player: one player's holdings; offers: the offers and threads of this session; rules: this game's settings.",
    }),
    subject: Type.Optional(
      Type.Union([Type.String(), Type.Integer({ minimum: 0, maximum: 39 })], {
        description:
          "The deed (name, slug or position) for topic=deed, the seat letter for topic=player.",
      }),
    ),
  }),
  note: Type.Object({
    text: Type.String({
      maxLength: 2000,
      description: "Your complete private notes. Replaces earlier notes.",
    }),
  }),
  follow: Type.Object({ group: GroupParam }),
  unfollow: Type.Object({ group: GroupParam }),
  build: Type.Object({ property: PropertyParam }),
  sell_building: Type.Object({ property: PropertyParam }),
  mortgage: Type.Object({ property: PropertyParam }),
  unmortgage: Type.Object({ property: PropertyParam }),
  offer: Type.Object({
    to: Type.Optional(
      StringEnum(SEATS, {
        description: "Seat the offer is addressed to. Omit for an open offer anyone may accept.",
      }),
    ),
    give: AssetsParam,
    get: AssetsParam,
    comment: Type.Optional(CommentParam),
    replyTo: Type.Optional(
      Type.Integer({ minimum: 0, description: "Id of the offer this counter-offer answers." }),
    ),
  }),
  accept: Type.Object({ offerId: OfferIdParam }),
  reject: Type.Object({ offerId: OfferIdParam, comment: Type.Optional(CommentParam) }),
  withdraw: Type.Object({ offerId: OfferIdParam }),
  message: Type.Object({
    offerId: OfferIdParam,
    text: Type.String({
      minLength: 1,
      maxLength: 280,
      description: "Public comment in the offer's thread (at most 280 characters).",
    }),
  }),
  buy: NoParams,
  decline: NoParams,
  pay_jail_fine: NoParams,
  use_jail_card: NoParams,
  roll_for_doubles: NoParams,
  bid: Type.Object({
    amount: Type.Integer({
      minimum: 0,
      description: "Total bid in dollars (the question says the minimum).",
    }),
  }),
  pass_bid: NoParams,
  keep_mortgage: Type.Object({ property: PropertyParam }),
  pay_off_mortgage: Type.Object({ property: PropertyParam }),
  declare_bankruptcy: NoParams,
  done: NoParams,
} satisfies Record<string, TSchema>;

export type ToolParameters = typeof toolParameters;

export type ToolName = keyof ToolParameters;

export type ToolArgs<N extends ToolName = ToolName> = Static<ToolParameters[N]>;

export const TOOL_NAMES = [
  "inspect",
  "note",
  "follow",
  "unfollow",
  "build",
  "sell_building",
  "mortgage",
  "unmortgage",
  "offer",
  "accept",
  "reject",
  "withdraw",
  "message",
  "buy",
  "decline",
  "pay_jail_fine",
  "use_jail_card",
  "roll_for_doubles",
  "bid",
  "pass_bid",
  "keep_mortgage",
  "pay_off_mortgage",
  "declare_bankruptcy",
  "done",
] as const satisfies ReadonlyArray<ToolName>;

/**
 * Tools that answer the question (SPEC §6.3). `keep_mortgage` and `pay_off_mortgage` answer it
 * only when no mortgaged deed is left to decide; the host reports that through
 * `ToolOutcome.terminal`, which is what actually ends a wake.
 */
export const ANSWERING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "done",
  "buy",
  "decline",
  "pay_jail_fine",
  "use_jail_card",
  "roll_for_doubles",
  "bid",
  "pass_bid",
  "declare_bankruptcy",
  "keep_mortgage",
  "pay_off_mortgage",
]);

export const toolDescriptions: Readonly<Record<ToolName, string>> = {
  inspect:
    "Look something up without acting: the table, one title deed, one player's holdings, the session's offers and threads, or this game's settings. Does not end your wake.",
  note: "Replace your private notes. Notes are the only thing you remember from one decision to the next: keep plans, reads on opponents and promises there. Does not end your wake.",
  follow:
    "Be woken when a new offer involves a deed of this group. You already follow every group where you own a deed. Does not end your wake.",
  unfollow: "Stop being woken for new offers involving this group. Does not end your wake.",
  build:
    "Draft one house on a street (or the hotel on a street with 4 houses). Needs the complete color set, no mortgaged street in it, even building and bank supply. Applied when the round closes, in fixed order (at once in a buy decision).",
  sell_building:
    "Sell one building level of a street back to the bank at half price, keeping the set even. Applied when the round closes (at once while raising funds).",
  mortgage:
    "Mortgage an unimproved deed for its mortgage value; its color set must have no buildings.",
  unmortgage: "Lift a mortgage: pay the mortgage value plus 10%.",
  offer:
    "Propose a two-party trade of cash, deeds (no buildings in their color set) and Get Out of Jail Free cards, to one seat or open to anyone. It can be accepted from the next round; only its terms are enforced. No loans, no future payments, no rent immunity.",
  accept:
    "Accept an offer addressed to you or open to all, posted in an earlier round. Executed when the round closes, re-validated in fixed order; it may be dropped if the assets changed.",
  reject: "Reject an offer addressed to you, optionally with a public comment.",
  withdraw: "Withdraw one of your own open offers.",
  message: "Add a public comment to an offer's thread without changing its terms.",
  buy: "Buy the deed you landed on at its list price. Answers the question and ends your wake.",
  decline:
    "Do not buy the deed you landed on; it is auctioned. Answers the question and ends your wake.",
  pay_jail_fine: "Pay the jail fine, then roll and move. Answers the question and ends your wake.",
  use_jail_card:
    "Use a Get Out of Jail Free card, then roll and move. Answers the question and ends your wake.",
  roll_for_doubles:
    "Roll for doubles to leave jail; after the third failure you pay the fine and move. Answers the question and ends your wake.",
  bid: "Bid in the current auction. Bids are sealed per round; the highest bid of the round leads. Answers this auction round and ends your wake.",
  pass_bid: "Leave the current auction. Answers this auction round and ends your wake.",
  keep_mortgage:
    "Keep a deed you received mortgaged, paying 10% of its mortgage value now. Ends your wake when no mortgaged deed is left to decide.",
  pay_off_mortgage:
    "Lift the mortgage of a deed you received: pay its mortgage value plus 10%. Ends your wake when no mortgaged deed is left to decide.",
  declare_bankruptcy:
    "Give up: you cannot pay your debt; your assets go to your creditor. Answers the question and ends your wake.",
  done: "Finish your part of this round: your drafts are submitted and you wait for the others. Answers the question and ends your wake.",
};

/** Checks arguments received over the wire (e.g. by GameDO) against the tool's schema. */
export const isToolArgs = <N extends ToolName>(name: N, args: unknown): args is ToolArgs<N> =>
  Value.Check(toolParameters[name], args);
