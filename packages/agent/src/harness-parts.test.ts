import {
  apply,
  Command,
  command,
  type CommandKind,
  CommandKind as CommandKindSchema,
  createConfig,
  defaultRules,
  digest,
  type GameEvent,
  type GameState,
  GROUP_IDS,
  newGame,
  playerView,
  PROPERTIES,
  requestOf,
  SEATS,
} from "@mb/engine";
import { allDone, answerFor, own, play, startGame, withPlayer } from "@mb/engine/testing";
import { Result, Schema } from "effect";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import {
  commandFromTool,
  isCommandTool,
  resolveProperty,
  TOOL_COMMANDS,
  toolsForKinds,
} from "./commands.ts";
import { CLOSED_DECISION, engineExecutor, inspectText } from "./engine-tools.ts";
import { buildSystemPrompt, wakeLimitsOf } from "./prompt.ts";
import {
  TOOL_NAMES,
  toolDescriptions,
  toolParameters,
  type ToolArgs,
  type ToolName,
} from "./tools.ts";
import { renderWakeMessage } from "./wake-message.ts";

const isCommand = Schema.is(Command);

/** Field names of an engine command kind, without the ones the host adds. */
const commandFields = (kind: CommandKind): ReadonlyArray<string> =>
  Object.keys(Command.cases[kind].fields)
    .filter((field) => field !== "_tag" && field !== "seat" && field !== "decisionId")
    .sort();

/** The parts of a tool's JSON schema these tests read: what a provider is sent. */
interface ToolSchemaNode {
  readonly type?: string;
  readonly enum?: ReadonlyArray<string>;
  readonly anyOf?: ReadonlyArray<ToolSchemaNode>;
  readonly properties?: Readonly<Record<string, ToolSchemaNode>>;
}

/** A tool's parameters as the JSON a provider receives. */
const sentSchema = (name: ToolName): ToolSchemaNode =>
  JSON.parse(JSON.stringify(toolParameters[name]));

/** Paths of properties (at any depth) that state neither a `type` nor an `anyOf` of types. */
const untypedPaths = (path: string, node: ToolSchemaNode): ReadonlyArray<string> => [
  ...(node.type === undefined && node.anyOf === undefined ? [path] : []),
  ...Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
    untypedPaths(`${path}.${key}`, child),
  ),
];

describe("tools against the engine", () => {
  it("exposes exactly the SPEC §6.3 tool set", () => {
    expect([...TOOL_NAMES].sort()).toEqual(Object.keys(toolParameters).sort());
    expect(Object.keys(toolDescriptions).sort()).toEqual(Object.keys(toolParameters).sort());
    expect(TOOL_NAMES).toHaveLength(24);
  });

  it("maps every seat command of the engine to one tool with the same fields", () => {
    const seatKinds = CommandKindSchema.literals.filter(
      (kind) => kind !== "TimeoutSeat" && kind !== "AbortGame",
    );

    expect(Object.values(TOOL_COMMANDS).sort()).toEqual([...seatKinds].sort());

    for (const tool of TOOL_NAMES.filter(isCommandTool)) {
      const parameters = Object.keys(toolParameters[tool].properties).sort();

      expect({ tool, fields: parameters }).toEqual({
        tool,
        fields: commandFields(TOOL_COMMANDS[tool]),
      });
    }
  });

  it("offers exactly the engine's group and seat literals", () => {
    expect(sentSchema("follow").properties?.group?.enum).toEqual([...GROUP_IDS]);
    expect(sentSchema("offer").properties?.to?.enum).toEqual([...SEATS]);
  });

  it("states a type on every tool property, as strict providers require (Moonshot)", () => {
    const untyped = TOOL_NAMES.flatMap((name) => untypedPaths(name, sentSchema(name)));

    expect(untyped).toEqual([]);
  });

  it("builds commands the engine schema accepts, from names, slugs and positions", () => {
    const answer = { seat: "B" as const, decisionId: "7.1.B" };

    const samples: ReadonlyArray<readonly [keyof typeof TOOL_COMMANDS, ToolArgs]> = [
      ["follow", { group: "dark-blue" }],
      ["unfollow", { group: "railroads" }],
      ["build", { property: "Boardwalk" }],
      ["sell_building", { property: 39 }],
      ["mortgage", { property: "reading-railroad" }],
      ["unmortgage", { property: "St. Charles Place" }],
      [
        "offer",
        {
          to: "A",
          give: { cash: 100, properties: ["B&O Railroad", 1] },
          get: { jailCards: 1 },
          comment: "Deal?",
          replyTo: 2,
        },
      ],
      ["offer", { give: {}, get: { cash: 50 } }],
      ["accept", { offerId: 3 }],
      ["reject", { offerId: 3, comment: "No." }],
      ["withdraw", { offerId: 4 }],
      ["message", { offerId: 4, text: "Still open." }],
      ["buy", {}],
      ["decline", {}],
      ["pay_jail_fine", {}],
      ["use_jail_card", {}],
      ["roll_for_doubles", {}],
      ["bid", { amount: 120 }],
      ["pass_bid", {}],
      ["keep_mortgage", { property: "Illinois" }],
      ["pay_off_mortgage", { property: "24" }],
      ["declare_bankruptcy", {}],
      ["done", {}],
    ];

    for (const [tool, args] of samples) {
      expect(Value.Check(toolParameters[tool], args)).toBe(true);

      // SAFETY: Value.Check just proved `args` matches the tool's parameter schema.
      const built = commandFromTool(answer, tool, args as ToolArgs<typeof tool>);

      expect(Result.isSuccess(built) && isCommand(built.success)).toBe(true);
      expect(Result.isSuccess(built) && built.success._tag).toBe(TOOL_COMMANDS[tool]);
    }

    const offer = commandFromTool(answer, "offer", {
      to: "A",
      give: { cash: 100, properties: ["B&O Railroad", 1] },
      get: { jailCards: 1 },
    });

    expect(Result.isSuccess(offer) && offer.success).toEqual(
      command("Offer", {
        seat: "B",
        decisionId: "7.1.B",
        to: "A",
        give: { cash: 100, properties: ["b-and-o-railroad", "mediterranean-avenue"], jailCards: 0 },
        get: { cash: 0, properties: [], jailCards: 1 },
      }),
    );
  });

  it("resolves every deed by name, slug and position, and refuses unknown or ambiguous ones", () => {
    for (const info of PROPERTIES) {
      expect(resolveProperty(info.name)).toBe(info.id);
      expect(resolveProperty(info.id)).toBe(info.id);
      expect(resolveProperty(info.position)).toBe(info.id);
      expect(resolveProperty(String(info.position))).toBe(info.id);
    }

    expect(resolveProperty("illinois")).toBe("illinois-avenue");
    expect(resolveProperty("pennsylvania")).toBeNull();
    expect(resolveProperty(0)).toBeNull();
    expect(resolveProperty("Free Parking")).toBeNull();

    const refused = commandFromTool({ seat: "A", decisionId: "x" }, "build", {
      property: "Park Lane",
    });

    expect(Result.isFailure(refused) && refused.failure).toContain('Unknown deed "Park Lane"');
  });

  it("names tools for engine command kinds", () => {
    expect(toolsForKinds(["Buy", "Decline", "Build", "TimeoutSeat"])).toEqual([
      "buy",
      "decline",
      "build",
    ]);
  });
});

describe("engine executor", () => {
  const host = (start: GameState) => {
    let state = start;
    let notes = "";

    return {
      get state() {
        return state;
      },
      get notes() {
        return notes;
      },
      seat: {
        state: () => state,
        submit: (next: Command) =>
          Result.map(apply(state, next), (applied) => {
            state = applied.state;

            return applied.events;
          }),
        notes: () => notes,
        saveNotes: (text: string) => {
          notes = text;
        },
      },
    };
  };

  it("applies commands at once, returns engine reasons, and ends on the answer", async () => {
    const game = host(startGame(2));
    const decisionId = requestOf(game.state, "A")?.decisionId ?? "";
    const execute = engineExecutor(game.seat, "A", decisionId);

    const build = await execute("build", { property: "Boardwalk" }, "c1");
    expect(build.ok).toBe(false);
    expect(build.terminal).toBe(false);
    expect(build.message.length).toBeGreaterThan(0);
    expect(build.message).not.toContain("Invalid arguments");

    const unknown = await execute("mortgage", { property: "Park Lane" }, "c2");
    expect(unknown.message).toContain("Unknown deed");

    const note = await execute("note", { text: "Buy oranges." }, "c3");
    expect(note.ok).toBe(true);
    expect(game.notes).toBe("Buy oranges.");

    const seen = await execute("inspect", { topic: "deed", subject: "boardwalk" }, "c4");
    expect(seen.message).toContain("Boardwalk (39, boardwalk), Dark Blue: price $400");

    const done = await execute("done", {}, "c5");
    expect(done).toMatchObject({ ok: true, terminal: true });

    const late = await execute("done", {}, "c6");
    expect(late).toEqual({ ok: false, message: CLOSED_DECISION, terminal: true });
  });

  it("answers inspect topics from the player view", () => {
    const state = own(startGame(2), "B", ["boardwalk", "park-place"]);
    const view = playerView(state, "A");

    expect(inspectText(view, { topic: "player", subject: "b" })).toContain(
      "Park Place (37) B; Boardwalk (39) B",
    );
    expect(inspectText(view, { topic: "rules" })).toContain("Starting cash $1,500");
    expect(inspectText(view, { topic: "offers" })).toBe("No offers this session.");
    expect(inspectText(view, { topic: "deed", subject: "nowhere" })).toContain("Unknown deed");
  });
});

describe("system prompt", () => {
  const rules = defaultRules();

  it("is a pure function of the rules and the player count", () => {
    expect(buildSystemPrompt(rules, 4)).toBe(buildSystemPrompt({ ...rules }, 4));
  });

  it("states the game's actual settings, the variants and the trading rule", () => {
    const prompt = buildSystemPrompt(
      { ...rules, startingCash: 2000, maxRounds: 40, jailFine: 75 },
      3,
    );

    expect(prompt).toContain("There are 3 players");
    expect(prompt).toContain("starts with $2,000");
    expect(prompt).toContain("after 40 full rounds");
    expect(prompt).toContain("pay $75 and roll");
    expect(prompt).toContain("Declared variants");
    expect(prompt).toContain("no rent immunity");
    expect(prompt).toContain("Boardwalk (39)");
    expect(prompt).toContain("24 tool calls, 6 invalid calls, 180 seconds");
    expect(wakeLimitsOf(rules)).toEqual({
      maxToolCallsPerWake: 24,
      maxInvalidPerWake: 6,
      wakeTimeoutMs: 180_000,
    });
  });
});

describe("wake message", () => {
  it("renders a reviewable wake message (snapshot)", async () => {
    const config = createConfig({
      gameId: "fixture",
      seed: "fixture-seed",
      seats: [
        { seat: "A", label: "Claude Opus 5.5", competitorId: "anthropic/claude-opus-5.5" },
        { seat: "B", label: "GPT-6.1 Sol", competitorId: "openai/gpt-6.1-sol" },
        { seat: "C", label: "Bot (heuristic)", competitorId: "bot:heuristic" },
      ],
    });

    const started = newGame(config);
    const events: Array<GameEvent> = [...started.events];
    let state = own(started.state, "A", ["st-james-place", "tennessee-avenue"]);

    state = own(state, "B", ["new-york-avenue", "reading-railroad"]);
    state = own(state, "B", ["boardwalk"], { mortgaged: true });
    state = withPlayer(state, "C", { cash: 640, jailCards: ["chance"] });

    const offer = play(
      state,
      answerFor(state, "A", "Offer", {
        to: "B",
        give: { cash: 250, properties: [], jailCards: 0 },
        get: { cash: 0, properties: ["new-york-avenue"], jailCards: 0 },
        comment: "Completes my orange set; fair price.",
      }),
    );

    events.push(...offer.events);

    const closed = allDone(offer.state);
    events.push(...closed.events);
    state = closed.state;

    const request = requestOf(state, "B");

    if (request === null) throw new Error("B should be woken in round 2 (addressed)");

    const message = renderWakeMessage({
      view: playerView(state, "B"),
      request,
      digest: digest(events, 0, "B"),
      notes: "A is collecting orange. Do not sell New York cheap.",
    });

    expect(request.reasons).toContain("addressed");
    expect(message).toContain("A → B, open");
    await expect(message).toMatchFileSnapshot("__snapshots__/wake-message.txt");
  });
});
