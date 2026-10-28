/**
 * Plausible wake transcripts for the LLM seats of a mock game, derived from what each seat did in
 * the event log: one wake per decision, with reasoning, the tool calls that match the actions and
 * usage from the model's price level.
 */
import type { ToolCallRecord, WakeTranscript } from "@mb/api";
import {
  GROUP_NAMES,
  evolve,
  initialState,
  netWorth,
  propertyInfo,
  rentFor,
  type DraftCommand,
  type GameConfig,
  type GameEvent,
  type GameState,
  type PropertyId,
  type Seat,
  type WakeReason,
} from "@mb/engine";
import { Match, Predicate } from "effect";

import { competitorById } from "./competitors.ts";
import { between, intBetween, pick } from "./random.ts";

/** A transcript plus the index of the event that completed it. */
export interface MockWake {
  readonly eventIndex: number;
  readonly transcript: WakeTranscript;
}

const BASE_TIME = Date.parse("2026-10-28T08:00:00.000Z");

const JAIL_TOOLS = {
  fine: "pay_jail_fine",
  card: "use_jail_card",
  doubles: "roll_for_doubles",
  forcedFine: "roll_for_doubles",
} as const satisfies Readonly<Record<string, string>>;

const toolName = (command: DraftCommand): string =>
  Match.value(command).pipe(
    Match.tagsExhaustive({
      Build: () => "build",
      SellBuilding: () => "sell_building",
      Mortgage: () => "mortgage",
      Unmortgage: () => "unmortgage",
      Offer: () => "offer",
      Accept: () => "accept",
      Reject: () => "reject",
      Withdraw: () => "withdraw",
      Message: () => "message",
      Bid: () => "bid",
      PassBid: () => "pass_bid",
    }),
  );

const argsOf = (command: DraftCommand): string => {
  const { _tag: _ignored, ...rest } = command;

  const fields = Object.fromEntries(
    Object.entries(rest).filter(([key]) => key !== "seat" && key !== "decisionId"),
  );

  return JSON.stringify(fields);
};

const call = (name: string, argsJson: string, result: string, ok = true): ToolCallRecord => ({
  name,
  argsJson,
  ok,
  result,
});

const nameOf = (property: PropertyId): string => propertyInfo(property).name;

const ownedGroups = (state: GameState, seat: Seat): ReadonlyArray<string> => {
  const groups = new Set(
    state.properties.flatMap((property) =>
      property.owner === seat ? [GROUP_NAMES[propertyInfo(property.id).group]] : [],
    ),
  );

  return [...groups];
};

const worstRent = (state: GameState, seat: Seat): number =>
  Math.max(
    0,
    ...state.properties.flatMap((property) =>
      property.owner === null || property.owner === seat || property.mortgaged
        ? []
        : [rentFor(state, property.id, 7, "none")],
    ),
  );

const tableReasoning = (
  key: string,
  state: GameState,
  seat: Seat,
  drafts: ReadonlyArray<DraftCommand>,
): string => {
  const player = state.players.find((candidate) => candidate.seat === seat);
  const cash = player?.cash ?? 0;
  const groups = ownedGroups(state, seat);
  const danger = worstRent(state, seat);

  if (drafts.length === 0) {
    return pick(
      key,
      [
        `Cash $${cash}, net worth $${netWorth(state, seat)}. The worst rent I can hit right now is about $${danger}, so I keep my cash. No trade on the table improves my position. Done for this round.`,
        `I hold ${groups.length === 0 ? "no complete color groups" : groups.join(", ")}. Nothing to build yet and no offer worth answering. I'll pass and keep $${cash} liquid.`,
        `Checked the open offers: none addressed to me is better than holding. Mortgaging would only weaken me. Done.`,
      ],
      "Done.",
    );
  }

  const first = drafts[0];

  if (first === undefined) return "Done.";

  return Match.value(first).pipe(
    Match.tag(
      "Build",
      (build) =>
        `I own the full ${GROUP_NAMES[propertyInfo(build.property).group]} set and have $${cash}. Building evenly starting with ${nameOf(build.property)}: the third house is where rent jumps the most. Keeping a reserve above $${Math.max(100, danger)} for bad rolls.`,
    ),
    Match.tag(
      "Offer",
      (offer) =>
        `A deal is the fastest way to a monopoly. I'll propose ${offer.to === undefined ? "an open offer" : `an offer to ${offer.to}`}: they get value now, I get the deed I need for a set. If they counter, I can go a bit higher.`,
    ),
    Match.tag(
      "Accept",
      (accept) =>
        `Offer #${accept.offerId} gives me what I need for a set and the price is fair at my cash level ($${cash}). Accepting before someone else does.`,
    ),
    Match.tag(
      "Reject",
      (reject) =>
        `Offer #${reject.offerId} hands them a monopoly for too little. Rejecting, with a note about what I would accept.`,
    ),
    Match.tag(
      "Mortgage",
      (mortgage) =>
        `I need cash: mortgaging ${nameOf(mortgage.property)} (no buildings in that group) is the cheapest way to raise it.`,
    ),
    Match.tag(
      "Unmortgage",
      (unmortgage) =>
        `Cash is comfortable ($${cash}). Lifting the mortgage on ${nameOf(unmortgage.property)} so it earns rent again.`,
    ),
    Match.tag(
      "SellBuilding",
      (sell) =>
        `Selling a level on ${nameOf(sell.property)} to stay solvent; I will rebuild later.`,
    ),
    Match.orElse(() => `Acting on the open negotiation this round, then done.`),
  );
};

interface Pending {
  readonly seat: Seat;
  readonly drafts: Array<DraftCommand>;
}

/** All LLM wakes of a game, in log order. */
export const mockWakes = (
  config: GameConfig,
  events: ReadonlyArray<GameEvent>,
): ReadonlyArray<MockWake> => {
  const llmSeats = new Set(
    config.seats.filter((seat) => !seat.competitorId.startsWith("bot:")).map((seat) => seat.seat),
  );

  const wakes: Array<MockWake> = [];
  const drafts = new Map<string, Pending>();
  let state = initialState(config);

  const push = (
    eventIndex: number,
    seat: Seat,
    frame: string,
    round: number,
    reasons: ReadonlyArray<WakeReason>,
    reasoning: string,
    toolCalls: ReadonlyArray<ToolCallRecord>,
  ): void => {
    if (!llmSeats.has(seat)) return;

    const seatConfig = config.seats.find((candidate) => candidate.seat === seat);
    const competitor = competitorById(seatConfig?.competitorId ?? "");
    const key = `${config.gameId}:${eventIndex}:${seat}`;
    const isReasoningModel = (seatConfig?.competitorId ?? "").includes(":high");
    const outputTokens = intBetween(`${key}:out`, 90, 620);
    const reasoningTokens = isReasoningModel ? intBetween(`${key}:reason`, 400, 3800) : 0;
    const costUsd = ((competitor?.costPerGameUsd ?? 1) / 260) * between(`${key}:cost`, 0.6, 1.5);
    const latency = (competitor?.avgWakeMs ?? 8000) * between(`${key}:lat`, 0.5, 1.6);
    const started = BASE_TIME + eventIndex * 9000;

    wakes.push({
      eventIndex,
      transcript: {
        gameId: config.gameId,
        seat,
        decisionId: `${frame}.${round}.${seat}.${eventIndex}`,
        turn: state.control.turn,
        frame,
        round,
        reasons: [...reasons],
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date(started + latency).toISOString(),
        prompt: "",
        reasoning,
        text: "",
        toolCalls: [...toolCalls],
        usage: {
          inputTokens: intBetween(`${key}:in`, 2600, 9400),
          outputTokens,
          reasoningTokens,
          costUsd,
        },
        invalidActions: toolCalls.filter((record) => !record.ok).length,
        timedOut: false,
      },
    });
  };

  for (const [index, event] of events.entries()) {
    const before = state;
    const frame = before.control.stack.at(-1);
    const key = `${config.gameId}:${index}`;

    if (Predicate.isTagged(event, "DraftAdded")) {
      const draftKey = `${event.frameId}.${event.round}.${event.seat}`;
      const pending = drafts.get(draftKey) ?? { seat: event.seat, drafts: [] };

      pending.drafts.push(event.command);
      drafts.set(draftKey, pending);
    }

    if (Predicate.isTagged(event, "SeatDone") && event.via === "done" && frame !== undefined) {
      const draftKey = `${event.frameId}.${event.round}.${event.seat}`;
      const seatDrafts = drafts.get(draftKey)?.drafts ?? [];

      const reasons = Match.value(frame).pipe(
        Match.tag(
          "Table",
          "RaiseFunds",
          (session) => session.reasons.find((entry) => entry.seat === event.seat)?.reasons ?? [],
        ),
        Match.orElse(() => []),
      );

      const inspect =
        intBetween(`${key}:inspect`, 0, 3) === 0
          ? [call("inspect", '{"what":"board"}', "Board summary returned.")]
          : [];

      const invalid =
        intBetween(`${key}:invalid`, 0, 40) === 0
          ? [
              call(
                "build",
                '{"property":"boardwalk"}',
                "Illegal: you do not own every street of the Dark Blue group.",
                false,
              ),
            ]
          : [];

      push(
        index,
        event.seat,
        frame._tag,
        event.round,
        reasons,
        tableReasoning(key, before, event.seat, seatDrafts),
        [
          ...inspect,
          ...invalid,
          ...seatDrafts.map((command) =>
            call(
              toolName(command),
              argsOf(command),
              "Draft recorded; applied when the round closes.",
            ),
          ),
          call("done", "{}", "Round finished for you."),
        ],
      );
    }

    if (
      Predicate.isTagged(event, "AuctionRoundClosed") &&
      frame !== undefined &&
      Predicate.isTagged(frame, "Auction")
    ) {
      const info = propertyInfo(frame.property);

      for (const bid of event.bids) {
        const reasoning =
          bid.amount === null
            ? `${info.name} is not worth more than the current high bid to me. Passing.`
            : `${info.name} (list $${info.price}) ${GROUP_NAMES[info.group]}: worth about $${Math.round(info.price * between(`${key}:${bid.seat}:value`, 0.8, 1.4))} to me. Bidding $${bid.amount} with sealed bids; others bid at the same time.`;

        push(index, bid.seat, "Auction", event.round, ["bidder"], reasoning, [
          bid.amount === null
            ? call("pass_bid", "{}", "You are out of this auction.")
            : call("bid", JSON.stringify({ amount: bid.amount }), "Bid recorded."),
        ]);
      }
    }

    if (
      Predicate.isTagged(event, "PropertyBought") &&
      frame !== undefined &&
      Predicate.isTagged(frame, "BuyChoice")
    ) {
      const info = propertyInfo(event.property);

      push(
        index,
        event.seat,
        "BuyChoice",
        1,
        ["active"],
        `${info.name} for $${event.price}. ${GROUP_NAMES[info.group]} deeds block opponents and work toward a set. I can afford it and stay above my safety margin. Buying.`,
        [call("buy", "{}", `You bought ${info.name}.`)],
      );
    }

    if (Predicate.isTagged(event, "PurchaseDeclined")) {
      const info = propertyInfo(event.property);

      push(
        index,
        event.seat,
        "BuyChoice",
        1,
        ["active"],
        `${info.name} at $${info.price} is too expensive for my cash right now. Declining: it goes to auction, where I may still get it cheaper.`,
        [call("decline", "{}", "Declined; the deed goes to auction.")],
      );
    }

    if (Predicate.isTagged(event, "LeftJail") && event.via !== "forcedFine") {
      const tool = JAIL_TOOLS[event.via];

      push(
        index,
        event.seat,
        "JailChoice",
        1,
        ["active"],
        event.via === "doubles"
          ? "Rolling for doubles: staying in jail is not bad while I collect rent."
          : "Getting out now: there are unowned deeds worth buying.",
        [call(tool, "{}", "Leaving jail.")],
      );
    }

    if (Predicate.isTagged(event, "JailRollFailed")) {
      push(
        index,
        event.seat,
        "JailChoice",
        1,
        ["active"],
        "The board is dangerous; jail is a safe place to wait. Rolling for doubles.",
        [call("roll_for_doubles", "{}", "No doubles; you stay in jail.")],
      );
    }

    state = evolve(state, event);
  }

  return wakes;
};
