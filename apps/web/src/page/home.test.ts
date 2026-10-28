import { AsyncData } from "foldkit";
import * as Scene from "foldkit/scene";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SORT,
  headToHead,
  nextSort,
  rankEntries,
  sortEntries,
} from "../domain/leaderboard.ts";
import { leaderboard } from "../testing/fixtures.ts";
import {
  FetchLeaderboard,
  LeaderboardAsyncData,
  Message,
  init,
  update,
  view,
  type Model,
} from "./home.ts";

const loaded = (players: 2 | 3 | 4 | 5 | 6 = 4): Model => ({
  players,
  leaderboard: LeaderboardAsyncData.Success({ data: leaderboard(players) }),
  sort: DEFAULT_SORT,
});

const sceneView = Scene.withViewInputs(view, { liveGames: AsyncData.Idle() });

describe("leaderboard domain", () => {
  it("ranks by score, highest first", () => {
    expect(
      rankEntries(leaderboard(4).entries).map((row) => [row.rank, row.entry.competitorId]),
    ).toEqual([
      [1, "b/beta"],
      [2, "a/alpha"],
      [3, "c/gamma"],
    ]);
  });

  it("sorts by any column and flips direction on a second click", () => {
    const byGames = nextSort(DEFAULT_SORT, "Games");

    expect(byGames).toEqual({ column: "Games", direction: "Descending" });
    expect(
      sortEntries(leaderboard(4).entries, byGames).map((row) => row.entry.competitorId),
    ).toEqual(["c/gamma", "b/beta", "a/alpha"]);

    expect(nextSort(byGames, "Games")).toEqual({ column: "Games", direction: "Ascending" });
    expect(nextSort(byGames, "AvgPlace")).toEqual({ column: "AvgPlace", direction: "Ascending" });
  });

  it("reads head-to-head cells in both orientations", () => {
    const cells = leaderboard(4).headToHead;

    expect(headToHead(cells, "a/alpha", "b/beta")).toEqual({ games: 10, ahead: 3 });
    expect(headToHead(cells, "b/beta", "a/alpha")).toEqual({ games: 10, ahead: 7 });
    expect(headToHead(cells, "a/alpha", "c/gamma")).toBeNull();
  });
});

describe("home update", () => {
  it("loads the 4-player leaderboard first", () => {
    const init_ = init();

    expect(init_.model.players).toBe(4);
    expect(init_.commands?.map((command) => command.name)).toEqual(["FetchLeaderboard"]);
  });

  it("switching the player-count tab refetches and keeps the old table while loading", () => {
    story(
      update,
      given(loaded(4)),
      message(Message.SelectedPlayers({ players: 2 })),
      model((next) => {
        expect(next.players).toBe(2);
        expect(next.leaderboard._tag).toBe("Refreshing");
      }),
      Command.expectExact(FetchLeaderboard({ players: 2 })),
      Command.resolve(
        FetchLeaderboard,
        Message.SucceededFetchLeaderboard({ leaderboard: leaderboard(2) }),
      ),
      model((next) => {
        expect(next.leaderboard).toEqual(LeaderboardAsyncData.Success({ data: leaderboard(2) }));
      }),
    );
  });

  it("ignores a late response for a tab that is no longer selected", () => {
    story(
      update,
      given({ ...loaded(4), players: 3 }),
      message(Message.SucceededFetchLeaderboard({ leaderboard: leaderboard(5) })),
      model((next) => expect(next.leaderboard).toEqual(loaded(4).leaderboard)),
      message(Message.FailedFetchLeaderboard({ players: 5, error: "boom" })),
      model((next) => expect(next.leaderboard).toEqual(loaded(4).leaderboard)),
    );
  });

  it("a failed refresh keeps the previous table as stale", () => {
    story(
      update,
      given(loaded(4)),
      message(Message.ClickedRetry()),
      Command.resolve(
        FetchLeaderboard,
        Message.FailedFetchLeaderboard({ players: 4, error: "offline" }),
      ),
      model((next) => expect(next.leaderboard._tag).toBe("Stale")),
    );
  });
});

describe("home view", () => {
  it("renders the table in rank order and re-sorts on header clicks", () => {
    Scene.scene(
      { update, view: sceneView() },
      Scene.given(loaded(4)),
      Scene.expect(Scene.role("heading", { name: "Leaderboard" })).toExist(),
      Scene.expect(Scene.nth(Scene.all.role("row"), 1)).toContainText("B/BETA"),
      Scene.click(Scene.role("button", { name: "Games" })),
      Scene.expect(Scene.nth(Scene.all.role("row"), 1)).toContainText("C/GAMMA"),
      Scene.click(Scene.role("button", { name: "Games" })),
      Scene.expect(Scene.nth(Scene.all.role("row"), 1)).toContainText("A/ALPHA"),
    );
  });

  it("selecting a tab marks it selected", () => {
    Scene.scene(
      { update, view: sceneView() },
      Scene.given(loaded(4)),
      Scene.expect(Scene.role("tab", { name: "4P" })).toHaveAttr("aria-selected", "true"),
      Scene.click(Scene.role("tab", { name: "6P" })),
      Scene.Command.resolve(
        FetchLeaderboard,
        Message.SucceededFetchLeaderboard({ leaderboard: leaderboard(6) }),
      ),
      Scene.expect(Scene.role("tab", { name: "6P" })).toHaveAttr("aria-selected", "true"),
    );
  });

  it("shows an empty state when nobody has played this table size", () => {
    Scene.scene(
      { update, view: sceneView() },
      Scene.given({
        ...loaded(5),
        leaderboard: LeaderboardAsyncData.Success({
          data: { ...leaderboard(5), entries: [], headToHead: [] },
        }),
      }),
      Scene.expect(Scene.text("No rated games yet")).toExist(),
    );
  });

  it("shows the live games strip when games are running", () => {
    Scene.scene(
      {
        update,
        view: sceneView({
          liveGames: AsyncData.Success({
            data: {
              games: [
                {
                  id: "live-1",
                  runId: "run-1",
                  seed: "s",
                  status: "running",
                  playersCount: 2,
                  startedAt: null,
                  finishedAt: null,
                  turn: 12,
                  round: 6,
                  endReason: null,
                  winnerSeat: null,
                  seats: [],
                },
              ],
            },
          }),
        }),
      },
      Scene.given(loaded(4)),
      Scene.expect(Scene.role("heading", { name: "Live games" })).toExist(),
      Scene.expect(Scene.text("Turn 12 · Round 6")).toExist(),
    );
  });
});
