/**
 * Compact English rendering of the engine's read models for the wake message and the
 * `inspect` tool (SPEC §6.2). Only what the seat may see (`PlayerView`); frames are rendered
 * by what matters for the decision, never with the engine's internal task list.
 */
import {
  assetsText,
  type DraftCommand,
  DraftCommand as DraftCommandSchema,
  Frame,
  GROUP_IDS,
  GROUP_NAMES,
  groupMembers,
  mortgageInterest,
  type Offer,
  type PlayerView,
  PROPERTIES,
  type PropertyId,
  type PropertyState,
  propertyInfo,
  type PublicPlayer,
  type RulesConfig,
  spaceName,
  unmortgageCost,
} from "@mb/engine";
import { Match } from "effect";

export const money = (amount: number): string => `$${amount.toLocaleString("en-US")}`;

const deedName = (id: PropertyId): string => propertyInfo(id).name;

const levelText = (level: number): string => {
  if (level >= 5) return "hotel";

  return level === 1 ? "1 house" : `${level} houses`;
};

const playerLine = (view: PlayerView, player: PublicPlayer): string => {
  const who = `${player.seat}${player.seat === view.seat ? " (you)" : ""} ${player.label}`;

  if (player.bankrupt) return `- ${who}: bankrupt at turn ${player.bankruptAtTurn ?? "?"}.`;

  const place = player.inJail
    ? `in jail (${player.jailAttempts} failed ${player.jailAttempts === 1 ? "roll" : "rolls"})`
    : `on ${spaceName(player.position)} (${player.position})`;

  const cards =
    player.jailCards.length === 0
      ? ""
      : `, ${player.jailCards.length} Get Out of Jail Free card${player.jailCards.length === 1 ? "" : "s"}`;

  const active = player.seat === view.activeSeat ? ", to play" : "";

  return `- ${who}: ${money(player.cash)} cash, ${place}, net worth ${money(player.netWorth)}${cards}${active}.`;
};

const deedLine = (property: PropertyState): string => {
  const info = propertyInfo(property.id);
  const head = `${info.name} (${info.position})`;

  if (property.owner === null) return `${head} unowned ${money(info.price)}`;

  const extras = [
    ...(property.level > 0 ? [levelText(property.level)] : []),
    ...(property.mortgaged ? ["mortgaged"] : []),
  ];

  return `${head} ${property.owner}${extras.length === 0 ? "" : ` ${extras.join(", ")}`}`;
};

/** One line per color group: every deed with its owner, buildings and mortgage. */
export const renderDeeds = (properties: ReadonlyArray<PropertyState>): ReadonlyArray<string> => {
  const byId = new Map(properties.map((property) => [property.id, property]));

  return GROUP_IDS.map((group) => {
    const deeds = groupMembers(group).flatMap((id) => {
      const property = byId.get(id);

      return property === undefined ? [] : [deedLine(property)];
    });

    return `- ${GROUP_NAMES[group]}: ${deeds.join("; ")}`;
  });
};

/** The current decision context in one line, from the top frame (no internal tasks). */
export const renderFrame = (view: PlayerView): string => {
  if (view.frame === null)
    return view.status === "finished" ? "The game is over." : "No decision is open.";

  const stack = view.stack.length > 1 ? ` (frames: ${view.stack.join(" > ")})` : "";

  const now = Frame.match(view.frame, {
    Table: (frame) =>
      `Open table, round ${frame.round}; waiting for ${frame.awaiting.join(", ") || "nobody"}`,
    RaiseFunds: (frame) =>
      `${frame.debtor} must raise funds: owes ${money(frame.amount)} to ${frame.creditor === "bank" ? "the bank" : frame.creditor}, round ${frame.round}`,
    JailChoice: (frame) => `${frame.seat} chooses how to leave jail`,
    BuyChoice: (frame) => `${frame.seat} may buy ${deedName(frame.property)}`,
    Auction: (frame) =>
      `Auction for ${deedName(frame.property)}, round ${frame.round}: ${frame.high === null ? "no bids yet" : `high bid ${money(frame.high.amount)} by ${frame.high.seat}`}; still in: ${frame.active.join(", ")}`,
    BuildingAuction: (frame) =>
      `Building auction for ${frame.unitsLeft} ${frame.kind}(s), round ${frame.round}: ${frame.high === null ? "no bids yet" : `high premium ${money(frame.high.amount)} by ${frame.high.seat}`}; still in: ${frame.active.join(", ")}`,
    MortgagedTransfer: (frame) =>
      `${frame.seat} decides on mortgaged ${frame.properties.map(deedName).join(", ")}`,
  });

  return `${now}${stack}.`;
};

const draftText = (draft: DraftCommand): string =>
  DraftCommandSchema.match(draft, {
    Build: (command) => `build on ${deedName(command.property)}`,
    SellBuilding: (command) => `sell a building on ${deedName(command.property)}`,
    Mortgage: (command) => `mortgage ${deedName(command.property)}`,
    Unmortgage: (command) => `unmortgage ${deedName(command.property)}`,
    Offer: (command) =>
      `offer ${command.to === undefined ? "to everyone" : `to ${command.to}`}: give ${assetsText(command.give)}, get ${assetsText(command.get)}`,
    Accept: (command) => `accept #${command.offerId}`,
    Reject: (command) => `reject #${command.offerId}`,
    Withdraw: (command) => `withdraw #${command.offerId}`,
    Message: (command) => `message on #${command.offerId}`,
    Bid: (command) => `bid ${money(command.amount)}`,
    PassBid: () => "pass",
  });

/** The table as one seat sees it. */
export const renderPlayerView = (view: PlayerView): string => {
  const dice = view.lastDice === null ? "" : ` Last roll ${view.lastDice[0]}+${view.lastDice[1]}.`;

  const drafts =
    view.drafts.length === 0
      ? []
      : [`Your drafts this round: ${view.drafts.map(draftText).join("; ")}.`];

  return [
    `Turn ${view.turn}, round ${view.gameRound} of ${view.rules.maxRounds}. Bank: ${view.bank.houses} houses, ${view.bank.hotels} hotels.${dice}`,
    `Now: ${renderFrame(view)}`,
    "Players:",
    ...view.players.map((player) => playerLine(view, player)),
    "Deeds (owner, buildings):",
    ...renderDeeds(view.properties),
    `You follow: ${view.follows.join(", ") || "nothing"}.`,
    ...drafts,
  ].join("\n");
};

const offerLine = (offer: Offer): string => {
  const to = offer.to === null ? "everyone" : offer.to;
  const reply = offer.replyTo === null ? "" : ` (reply to #${offer.replyTo})`;
  const comment = offer.comment === null ? "" : ` "${offer.comment}"`;

  const rejected =
    offer.rejectedBy.length === 0 ? "" : ` Rejected by ${offer.rejectedBy.join(", ")}.`;

  const thread = offer.messages
    .map((message) => `\n    ${message.seat}: "${message.text}"`)
    .join("");

  return `- #${offer.id} ${offer.from} → ${to}, ${offer.status}${reply}: ${offer.from} gives ${assetsText(offer.give)}; gets ${assetsText(offer.get)}.${comment}${rejected}${thread}`;
};

/** Offers of the current session with their threads; empty when there are none. */
export const renderOffers = (offers: ReadonlyArray<Offer>): string =>
  offers.map(offerLine).join("\n");

/** One title deed with its printed numbers and current state. */
export const renderDeed = (view: PlayerView, id: PropertyId): string => {
  const info = propertyInfo(id);
  const property = view.properties.find((entry) => entry.id === id);

  const rents = Match.value(info.kind).pipe(
    Match.when(
      "street",
      () =>
        `rent ${info.rents.map(money).join(" / ")} (base, 1–4 houses, hotel; base doubles with the full unimproved set); house ${money(info.houseCost)}`,
    ),
    Match.when(
      "railroad",
      () => `rent ${info.rents.map(money).join(" / ")} for 1–4 railroads owned`,
    ),
    Match.when(
      "utility",
      () =>
        `rent ${info.rents.map((multiplier) => `${multiplier}×`).join(" / ")} the dice for 1–2 utilities owned`,
    ),
    Match.exhaustive,
  );

  return [
    `${info.name} (${info.position}, ${info.id}), ${GROUP_NAMES[info.group]}: price ${money(info.price)}, mortgage ${money(info.mortgage)} (lift ${money(unmortgageCost(id))}, interest on transfer ${money(mortgageInterest(id))}); ${rents}.`,
    `Now: ${property === undefined ? "unknown" : deedLine(property)}.`,
  ].join("\n");
};

/** One player's holdings. */
export const renderHoldings = (view: PlayerView, seat: string): string => {
  const player = view.players.find((entry) => entry.seat === seat);

  if (player === undefined) return `No seat ${seat} in this game.`;

  const deeds = view.properties.filter((property) => property.owner === player.seat).map(deedLine);

  return [playerLine(view, player), `Deeds: ${deeds.join("; ") || "none"}.`].join("\n");
};

/** This game's settings, as the system prompt states them. */
export const renderRules = (rules: RulesConfig): string =>
  [
    `Starting cash ${money(rules.startingCash)}, GO salary ${money(rules.goSalary)}, jail fine ${money(rules.jailFine)}.`,
    `Bank: ${rules.houses} houses, ${rules.hotels} hotels. Auctions open at ${money(rules.auctionMinOpening)} and rise by ${money(rules.auctionMinRaise)}.`,
    `Open table: ${rules.tableFrequency}, at most ${rules.maxTableRounds} rounds; per round ${rules.maxOffersPerRound} offers and ${rules.maxMessagesPerRound} messages, comments up to ${rules.commentMaxChars} characters.`,
    `Turn cap ${rules.maxRounds} full rounds. Notes up to ${rules.notesMaxChars} characters.`,
    `Per wake: ${rules.maxToolCallsPerWake} tool calls, ${rules.maxInvalidPerWake} invalid calls, ${Math.round(rules.wakeTimeoutMs / 1000)} seconds.`,
  ].join("\n");

/** Every deed in board order: name, position, slug (for prompts and errors). */
export const deedIndex = (): string =>
  PROPERTIES.map((info) => `${info.name} (${info.position}, ${info.id})`).join(", ");
