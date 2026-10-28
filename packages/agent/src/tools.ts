/**
 * The tool set of SPEC.md §6.3. Every model gets exactly these names, descriptions and
 * parameter schemas, always all of them. Illegal calls come back as tool errors with the
 * engine's reason and count as invalid actions.
 *
 * Parameter schemas are hand-written TypeBox mirrors of the engine commands (SPEC §4.4) in
 * phase 1; phase 2 checks them against the engine's Effect schemas (see apps/worker/README.md).
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

export const SEATS = ["A", "B", "C", "D", "E", "F"] as const;

/** Color groups plus railroads and utilities, the unit of `follow` (SPEC §5.3). */
export const PROPERTY_GROUPS = [
  "brown",
  "lightBlue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "darkBlue",
  "railroad",
  "utility",
] as const;

export const INSPECT_TOPICS = ["table", "deed", "player", "offers", "rules"] as const;

const GroupParam = Type.Enum(PROPERTY_GROUPS, {
  description: "Color group, or railroad / utility.",
});

const PropertyParam = Type.String({
  minLength: 1,
  description: 'Deed name as printed, e.g. "Boardwalk", "Reading Railroad", "Electric Company".',
});

const OfferIdParam = Type.String({ minLength: 1, description: "Id of an open offer." });

const CommentParam = Type.String({
  maxLength: 280,
  description: "Public, non-binding text attached to the offer (at most 280 characters).",
});

const BundleParam = Type.Object(
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
    topic: Type.Enum(INSPECT_TOPICS, {
      description:
        "table: the whole board and every player; deed: one title deed; player: one player's holdings; offers: open offers and threads; rules: the house settings of this game.",
    }),
    subject: Type.Optional(
      Type.String({ description: "Deed name for topic=deed, seat letter for topic=player." }),
    ),
  }),
  note: Type.Object({
    text: Type.String({
      maxLength: 2000,
      description: "Your complete private notes (at most 2000 characters). Replaces earlier notes.",
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
      Type.Enum(SEATS, {
        description: "Seat the offer is addressed to. Omit for an open offer anyone may accept.",
      }),
    ),
    give: BundleParam,
    get: BundleParam,
    comment: Type.Optional(CommentParam),
    replyTo: Type.Optional(
      Type.String({ minLength: 1, description: "Offer id this counter-offer answers." }),
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
      minimum: 1,
      description: "Total bid in dollars: at least $10 to open, at least $1 above the high bid.",
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
    "Look something up without acting: the whole table, one title deed, one player's holdings, the open offers and threads, or this game's house settings. Does not end your wake.",
  note: "Replace your private notes. Notes are the only thing you remember from one decision to the next; keep plans, reads on opponents and promises there. Does not end your wake.",
  follow:
    "Ask to be woken when a new offer involves a property of this group. You already follow every group where you own a deed. Does not end your wake.",
  unfollow: "Stop being woken for new offers involving this group. Does not end your wake.",
  build:
    "Draft one house on a street (or a hotel on a street with 4 houses). Needs the complete color set, no mortgaged street in it, even building, and bank supply. Applied when the round closes, in fixed order.",
  sell_building:
    "Sell one building level on a street back to the bank for half its price, keeping the set even. Applied when the round closes (immediately while raising funds).",
  mortgage:
    "Mortgage an unimproved deed for its mortgage value. The whole color set must have no buildings.",
  unmortgage: "Pay the mortgage value plus 10% to lift a mortgage.",
  offer:
    "Propose a two-party trade of cash, deeds (no buildings in their color set) and Get Out of Jail Free cards. Address it to a seat or leave it open for anyone. Can be accepted from the next round; only the terms are enforced. No loans, no future payments, no rent immunity.",
  accept:
    "Accept an open offer addressed to you or open to all. Executed when the round closes, re-validated in fixed order; it may be dropped if the assets changed.",
  reject: "Reject an offer addressed to you, optionally with a public comment.",
  withdraw: "Withdraw one of your own open offers.",
  message: "Add a public comment to an offer's thread without changing any terms.",
  buy: "Buy the property you landed on at its list price. Answers the question and ends your wake.",
  decline:
    "Do not buy the property you landed on; it goes to auction. Answers the question and ends your wake.",
  pay_jail_fine: "Pay the $50 fine, then roll and move. Answers the question and ends your wake.",
  use_jail_card:
    "Use a Get Out of Jail Free card, then roll and move. Answers the question and ends your wake.",
  roll_for_doubles:
    "Try to roll doubles to leave jail. On the third failed attempt you pay $50 and move. Answers the question and ends your wake.",
  bid: "Bid in the current auction. Bids are sealed per round; the highest bid of the round leads. Answers this auction round and ends your wake.",
  pass_bid: "Drop out of the current auction. Answers this auction round and ends your wake.",
  keep_mortgage:
    "Keep a mortgaged deed you received mortgaged, paying 10% of its mortgage value now. Ends your wake when no mortgaged deed is left to decide.",
  pay_off_mortgage:
    "Lift the mortgage of a deed you received, paying its mortgage value plus 10%. Ends your wake when no mortgaged deed is left to decide.",
  declare_bankruptcy:
    "Give up: you cannot pay your debt. Your assets go to your creditor. Answers the question and ends your wake.",
  done: "Finish your part of this round: your drafts are submitted and you wait for the others. Answers the question and ends your wake.",
};

/** Checks arguments received over the wire (e.g. by GameDO) against the tool's schema. */
export const isToolArgs = <N extends ToolName>(name: N, args: unknown): args is ToolArgs<N> =>
  Value.Check(toolParameters[name], args);
