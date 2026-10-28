/**
 * Tool calls → engine commands (`@mb/engine` `Command`, SPEC §4.4). The host adds `seat` and
 * `decisionId`; deeds are resolved from a printed name, a slug, a unique slug prefix or a
 * board position. Problems come back as plain English for the model.
 */
import {
  type Assets,
  type Command,
  type CommandKind,
  type CommandOf,
  command,
  PROPERTIES,
  type PropertyId,
  type Seat,
} from "@mb/engine";
import { Result } from "effect";

import type { ToolArgs, ToolName } from "./tools.ts";

/** The engine command kind behind every tool except the host-only `inspect` and `note`. */
export const TOOL_COMMANDS = {
  follow: "Follow",
  unfollow: "Unfollow",
  build: "Build",
  sell_building: "SellBuilding",
  mortgage: "Mortgage",
  unmortgage: "Unmortgage",
  offer: "Offer",
  accept: "Accept",
  reject: "Reject",
  withdraw: "Withdraw",
  message: "Message",
  buy: "Buy",
  decline: "Decline",
  pay_jail_fine: "PayJailFine",
  use_jail_card: "UseJailCard",
  roll_for_doubles: "RollForDoubles",
  bid: "Bid",
  pass_bid: "PassBid",
  keep_mortgage: "KeepMortgage",
  pay_off_mortgage: "PayOffMortgage",
  declare_bankruptcy: "DeclareBankruptcy",
  done: "Done",
} as const satisfies Readonly<Record<Exclude<ToolName, "inspect" | "note">, CommandKind>>;

export type CommandTool = keyof typeof TOOL_COMMANDS;

const COMMAND_TOOLS = new Map<CommandKind, ToolName>(
  Object.entries(TOOL_COMMANDS).flatMap(([tool, kind]) =>
    isToolName(tool) ? [[kind, tool] as const] : [],
  ),
);

function isToolName(name: string): name is CommandTool {
  return name in TOOL_COMMANDS;
}

export const isCommandTool = (name: ToolName): name is CommandTool => isToolName(name);

/** Tool names for engine command kinds (e.g. a request's `allowed` list), in that order. */
export const toolsForKinds = (kinds: ReadonlyArray<CommandKind>): ReadonlyArray<ToolName> =>
  kinds.flatMap((kind) => {
    const tool = COMMAND_TOOLS.get(kind);

    return tool === undefined ? [] : [tool];
  });

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const BY_KEY = new Map<string, PropertyId>(
  PROPERTIES.flatMap((info) => [
    [info.id, info.id],
    [slugOf(info.name), info.id],
    [String(info.position), info.id],
  ]),
);

/** A deed from its printed name, slug, unique slug prefix or board position; null if none. */
export const resolveProperty = (value: string | number): PropertyId | null => {
  const key = slugOf(String(value));
  const exact = BY_KEY.get(key);

  if (exact !== undefined) return exact;

  const prefixed = key.length === 0 ? [] : PROPERTIES.filter((info) => info.id.startsWith(key));

  return prefixed.length === 1 ? (prefixed[0]?.id ?? null) : null;
};

const unknownDeed = (value: string | number): string =>
  `Unknown deed "${value}": use a printed name ("Illinois Avenue"), a slug ("illinois-avenue") or a board position (24).`;

const withDeed = (
  value: string | number,
  build: (property: PropertyId) => Command,
): Result.Result<Command, string> => {
  const property = resolveProperty(value);

  return property === null ? Result.fail(unknownDeed(value)) : Result.succeed(build(property));
};

type AssetsArgs = ToolArgs<"offer">["give"];

const toAssets = (args: AssetsArgs): Result.Result<Assets, string> => {
  const properties: Array<PropertyId> = [];

  for (const value of args.properties ?? []) {
    const property = resolveProperty(value);

    if (property === null) return Result.fail(unknownDeed(value));

    properties.push(property);
  }

  return Result.succeed({ cash: args.cash ?? 0, properties, jailCards: args.jailCards ?? 0 });
};

interface Answer {
  readonly seat: Seat;
  readonly decisionId: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const offerCommand = (answer: Answer, args: ToolArgs<"offer">): Result.Result<Command, string> => {
  const give = toAssets(args.give);
  const get = toAssets(args.get);

  if (Result.isFailure(give)) return Result.fail(give.failure);

  if (Result.isFailure(get)) return Result.fail(get.failure);

  const input: Mutable<Omit<CommandOf<"Offer">, "_tag">> = {
    ...answer,
    give: give.success,
    get: get.success,
  };

  if (args.to !== undefined) input.to = args.to;

  if (args.comment !== undefined) input.comment = args.comment;

  if (args.replyTo !== undefined) input.replyTo = args.replyTo;

  return Result.succeed(command("Offer", input));
};

const rejectCommand = (answer: Answer, args: ToolArgs<"reject">): Command => {
  const input: Mutable<Omit<CommandOf<"Reject">, "_tag">> = { ...answer, offerId: args.offerId };

  if (args.comment !== undefined) input.comment = args.comment;

  return command("Reject", input);
};

const ok = (value: Command): Result.Result<Command, string> => Result.succeed(value);

/** One builder per command tool, typed by the tool's own arguments. */
type CommandBuilders = {
  readonly [K in CommandTool]: (
    answer: Answer,
    args: ToolArgs<K>,
  ) => Result.Result<Command, string>;
};

const builders: CommandBuilders = {
  follow: (answer, args) => ok(command("Follow", { ...answer, group: args.group })),
  unfollow: (answer, args) => ok(command("Unfollow", { ...answer, group: args.group })),
  build: (answer, args) =>
    withDeed(args.property, (property) => command("Build", { ...answer, property })),
  sell_building: (answer, args) =>
    withDeed(args.property, (property) => command("SellBuilding", { ...answer, property })),
  mortgage: (answer, args) =>
    withDeed(args.property, (property) => command("Mortgage", { ...answer, property })),
  unmortgage: (answer, args) =>
    withDeed(args.property, (property) => command("Unmortgage", { ...answer, property })),
  offer: offerCommand,
  accept: (answer, args) => ok(command("Accept", { ...answer, offerId: args.offerId })),
  reject: (answer, args) => ok(rejectCommand(answer, args)),
  withdraw: (answer, args) => ok(command("Withdraw", { ...answer, offerId: args.offerId })),
  message: (answer, args) =>
    ok(command("Message", { ...answer, offerId: args.offerId, text: args.text })),
  buy: (answer) => ok(command("Buy", answer)),
  decline: (answer) => ok(command("Decline", answer)),
  pay_jail_fine: (answer) => ok(command("PayJailFine", answer)),
  use_jail_card: (answer) => ok(command("UseJailCard", answer)),
  roll_for_doubles: (answer) => ok(command("RollForDoubles", answer)),
  bid: (answer, args) => ok(command("Bid", { ...answer, amount: args.amount })),
  pass_bid: (answer) => ok(command("PassBid", answer)),
  keep_mortgage: (answer, args) =>
    withDeed(args.property, (property) => command("KeepMortgage", { ...answer, property })),
  pay_off_mortgage: (answer, args) =>
    withDeed(args.property, (property) => command("PayOffMortgage", { ...answer, property })),
  declare_bankruptcy: (answer) => ok(command("DeclareBankruptcy", answer)),
  done: (answer) => ok(command("Done", answer)),
};

/** The engine command for a tool call answering `answer`'s decision, or why there is none. */
export const commandFromTool = <N extends CommandTool>(
  answer: Answer,
  tool: N,
  args: ToolArgs<N>,
): Result.Result<Command, string> => {
  const build: (answer: Answer, args: ToolArgs<N>) => Result.Result<Command, string> =
    builders[tool];

  return build(answer, args);
};
