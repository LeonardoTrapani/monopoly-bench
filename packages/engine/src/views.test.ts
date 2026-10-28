import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { digest, visibleTo } from "./digest.ts";
import { newGame, replay } from "./game.ts";
import { pending } from "./pending.ts";
import { Command, command } from "./schema/commands.ts";
import { GameConfig, RulesConfig } from "./schema/config.ts";
import { GameEventJson } from "./schema/events.ts";
import { GameState } from "./schema/state.ts";
import { PlayerView, SpectatorView } from "./schema/views.ts";
import { answerFor, eventsOf, play, rollFromTable, startGame, testConfig } from "./testing.ts";
import { playerView, spectatorView } from "./views.ts";

describe("config", () => {
  it("decodes a partial rules object with the SPEC §12 defaults", () => {
    const rules = Schema.decodeUnknownSync(RulesConfig)({ maxRounds: 50 });

    expect(rules.startingCash).toBe(1500);
    expect(rules.tableFrequency).toBe("everyTurn");
    expect(rules.maxTableRounds).toBe(6);
    expect(rules.maxRounds).toBe(50);
  });

  it("rejects configs with fewer than 2 seats", () => {
    const config = testConfig(2);

    expect(() =>
      Schema.decodeUnknownSync(GameConfig)({ ...config, seats: config.seats.slice(0, 1) }),
    ).toThrow();
  });
});

describe("events", () => {
  it("encode to JSON lines and decode back to the same events; replay rebuilds the state", () => {
    const config = testConfig(3);
    const started = newGame(config);
    const step = rollFromTable(started.state, [1, 2]);
    const all = [...started.events, ...step.events];
    const lines = all.map((event) => Schema.encodeSync(GameEventJson)(event));
    const decoded = lines.map((line) => Schema.decodeUnknownSync(GameEventJson)(line));

    expect(decoded).toEqual(all);
    expect(replay(config, decoded)).toEqual(step.state);
  });

  it("keep deck order for spectators only", () => {
    const { events } = newGame(testConfig(2));
    const shuffled = eventsOf(events, "DecksShuffled")[0];

    expect(shuffled).toBeDefined();

    if (shuffled === undefined) return;

    expect(visibleTo(shuffled, "A")).toBe(false);
    expect(visibleTo(shuffled, "spectator")).toBe(true);
  });

  it("carry seq, turn and visibility", () => {
    const { events } = newGame(testConfig(2));

    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.turn >= 0)).toBe(true);
  });
});

describe("views", () => {
  it("never expose deck order or other seats' drafts to a player", () => {
    const state = startGame(2);

    const drafted = play(
      state,
      answerFor(state, "A", "Offer", {
        to: "B",
        give: { cash: 10, properties: [], jailCards: 0 },
        get: { cash: 5, properties: [], jailCards: 0 },
      }),
    ).state;

    const view = playerView(drafted, "B");

    expect("decks" in view).toBe(false);
    expect(view.drafts).toEqual([]);
    expect(playerView(drafted, "A").drafts).toHaveLength(1);
    expect(spectatorView(drafted).decks.chance).toHaveLength(16);
  });

  it("are valid schema values", () => {
    const state = rollFromTable(startGame(3), [1, 2]).state;

    expect(() => Schema.encodeSync(PlayerView)(playerView(state, "A"))).not.toThrow();
    expect(() => Schema.encodeSync(SpectatorView)(spectatorView(state))).not.toThrow();
    expect(() => Schema.encodeSync(GameState)(state)).not.toThrow();
  });

  it("include the pending request with legal kinds and a question", () => {
    const state = rollFromTable(startGame(2), [1, 2]).state;
    const request = playerView(state, "A").request;

    expect(request?.frame).toBe("BuyChoice");
    expect(request?.allowed).toEqual(expect.arrayContaining(["Buy", "Decline"]));
    expect(request?.question).toContain("Baltic Avenue");
    expect(playerView(state, "B").request).toBeNull();
  });

  it("report the final standings once the game is over", () => {
    const state = play(startGame(2), command("AbortGame", { reason: "test" })).state;
    const result = pending(state);

    expect(result._tag).toBe("Finished");
  });
});

describe("digest", () => {
  it("renders short English lines since a cursor", () => {
    const started = newGame(testConfig(2));
    const step = rollFromTable(started.state, [1, 2]);
    const lines = digest([...started.events, ...step.events], started.state.seq, "A");

    expect(lines).toContain("A rolled 1+2 and landed on Baltic Avenue.");
    expect(lines.some((line) => line.includes("may buy Baltic Avenue for $60"))).toBe(true);
  });
});

describe("commands", () => {
  it("decode from JSON with optional offer fields", () => {
    const json =
      '{"_tag":"Offer","seat":"A","decisionId":"1.1.A","give":{"cash":10,"properties":["boardwalk"],"jailCards":0},"get":{"cash":0,"properties":[],"jailCards":0}}';

    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(json);

    expect(decoded._tag).toBe("Offer");
    expect(() =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Command))(
        json.replace("boardwalk", "atlantis"),
      ),
    ).toThrow();
  });
});
