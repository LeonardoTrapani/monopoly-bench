import type { RunSummary } from "@mb/api";
import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { describe, expect, it } from "vite-plus/test";

import { CancelAuth } from "./api/api.ts";
import { modelPath } from "./api/http.ts";
import { NavigateInternal, SaveRunTokens, ScrollToFragment } from "./command.ts";
import { LiveGamesAsyncData, Page, type Model } from "./model.ts";
import { Message } from "./message.ts";
import * as Competitor from "./page/competitor.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import {
  AppRoute,
  competitorHref,
  gameHref,
  newRunRouter,
  runHref,
  urlToAppRoute,
} from "./route.ts";
import { update } from "./update.ts";

const url = (path: string) =>
  Option.getOrThrowWith(fromString(`http://localhost${path}`), () => new Error(`Bad url ${path}`));

const route = (path: string) => urlToAppRoute(url(path));

const competitor = (competitorId: string) => AppRoute.Competitor({ competitorId });

describe("routes", () => {
  it("parses every page", () => {
    expect(route("/")).toEqual(AppRoute.Home());
    expect(route("/games")).toEqual(AppRoute.Games());
    expect(route("/games/g-1")).toEqual(AppRoute.Game({ gameId: "g-1" }));
    expect(route("/runs")).toEqual(AppRoute.Runs());
    expect(route("/runs/new")).toEqual(AppRoute.NewRun());
    expect(route("/runs/run-7")).toEqual(AppRoute.Run({ runId: "run-7" }));
    expect(route("/about")).toEqual(AppRoute.About());
    expect(route("/nowhere/at/all")._tag).toBe("NotFound");
  });

  it("keeps slashes and colons of raw competitor ids", () => {
    expect(route("/models/anthropic/claude-sonnet-5.5:high")).toEqual(
      competitor("anthropic/claude-sonnet-5.5:high"),
    );
    expect(route("/models/bot:random")).toEqual(competitor("bot:random"));
    expect(route("/models/openai/gpt-oss-240b:free")).toEqual(
      competitor("openai/gpt-oss-240b:free"),
    );
  });

  it("decodes percent-encoded competitor ids, so the route holds the raw id", () => {
    expect(route("/models/bot%3Arandom")).toEqual(competitor("bot:random"));
    expect(route("/models/anthropic%2Fclaude-sonnet-5.5%3Ahigh")).toEqual(
      competitor("anthropic/claude-sonnet-5.5:high"),
    );
    expect(route("/models/anthropic/claude-sonnet-5.5%3Ahigh")).toEqual(
      competitor("anthropic/claude-sonnet-5.5:high"),
    );
    expect(route("/models/~google%2Fgemini-latest")).toEqual(competitor("~google/gemini-latest"));
  });

  it("keeps a malformed escape as typed instead of failing", () => {
    expect(route("/models/acme/broken%E0%A4%A")).toEqual(competitor("acme/broken%E0%A4%A"));
  });

  it("encodes the competitor id exactly once for the API", () => {
    expect(modelPath("bot:random")).toBe("/api/models/bot%3Arandom");
    expect(modelPath("anthropic/claude-sonnet-5.5:high")).toBe(
      "/api/models/anthropic%2Fclaude-sonnet-5.5%3Ahigh",
    );

    const path = AppRoute.matchOrElse(
      route("/models/bot%3Arandom"),
      { Competitor: ({ competitorId }) => modelPath(competitorId) },
      () => null,
    );

    expect(path).toBe("/api/models/bot%3Arandom");
  });

  it("prints URLs that parse back to the same route", () => {
    const id = "openai/gpt-6.1-sol:high";

    expect(competitorHref(id)).toBe("/models/openai/gpt-6.1-sol:high");
    expect(route(competitorHref(id))).toEqual(competitor(id));
    expect(route(gameHref("abc"))).toEqual(AppRoute.Game({ gameId: "abc" }));
    expect(route(runHref("r1"))).toEqual(AppRoute.Run({ runId: "r1" }));
    expect(newRunRouter()).toBe("/runs/new");
  });
});

const homeInit = Home.init();

const home: Model = {
  route: AppRoute.Home(),
  page: Page.Home({ home: homeInit.model }),
  apiKey: "",
  runTokens: {},
  liveGames: LiveGamesAsyncData.Idle(),
};

describe("navigation", () => {
  it("a URL change to /games initialises the games page and its requests", () => {
    story(
      update,
      given(home),
      message(Message.ChangedUrl({ url: url("/games") })),
      model((next) => {
        expect(next.route).toEqual(AppRoute.Games());
        expect(next.page._tag).toBe("Games");
      }),
      Command.expectHas(Games.FetchGames({ query: Games.init().model.query }), Games.FetchModels()),
      Command.resolveAll(
        [
          Games.FetchGames,
          Games.Message.SucceededFetchGames({
            query: Games.init().model.query,
            response: { games: [] },
          }),
        ],
        [Games.FetchModels, Games.Message.FailedFetchModels({ error: "offline" })],
      ),
      model((next) => {
        const games = Page.matchOrElse(
          next.page,
          { Games: ({ games: page }) => Option.some(page) },
          () => Option.none(),
        );

        expect(Option.map(games, (page) => page.games._tag)).toEqual(Option.some("Success"));
      }),
    );
  });

  it("an encoded model URL loads the profile of the raw id", () => {
    story(
      update,
      given(home),
      message(Message.ChangedUrl({ url: url("/models/bot%3Arandom") })),
      model((next) => expect(next.route).toEqual(competitor("bot:random"))),
      Command.expectHas(Competitor.FetchProfile({ competitorId: "bot:random" })),
      Command.resolve(
        Competitor.FetchProfile,
        Competitor.Message.FailedFetchProfile({ error: "Model not found (HTTP 404)" }),
      ),
    );
  });

  it("the same URL keeps the page state", () => {
    story(
      update,
      given(home),
      message(Message.ChangedUrl({ url: url("/") })),
      Command.expectNone(),
      model((next) => expect(next.page).toBe(home.page)),
    );
  });

  it("a URL fragment scrolls to its section", () => {
    story(
      update,
      given(home),
      message(Message.ChangedUrl({ url: url("/about#costs") })),
      model((next) => expect(next.route).toEqual(AppRoute.About())),
      Command.expectHas(ScrollToFragment({ id: "costs" })),
      Command.resolve(ScrollToFragment, Message.CompletedScrollToFragment()),
    );
  });

  it("messages for a page that is no longer shown are ignored", () => {
    story(
      update,
      given(home),
      message(Message.GotGamesMessage({ message: Games.Message.ClickedRetry() })),
      Command.expectNone(),
      model((next) => expect(next).toEqual(home)),
    );
  });
});

const ownKeyRun: RunSummary = {
  id: "run-own",
  funding: "ownKey",
  name: null,
  createdAt: "2026-10-28T09:00:00.000Z",
  status: "queued",
  playersCount: 2,
  seats: [],
  gamesTotal: 2,
  gamesFinished: 0,
  gamesRunning: 0,
  spentUsd: 0,
  budgetUsd: 5,
};

describe("run cancel tokens", () => {
  it("an own-key run keeps its cancel token and opens the run page", () => {
    const newRun: Model = {
      ...home,
      route: AppRoute.NewRun(),
      page: Page.NewRun({ newRun: NewRun.init("").model }),
    };

    story(
      update,
      given(newRun),
      message(
        Message.GotNewRunMessage({
          message: NewRun.Message.SucceededCreateRun({
            response: { run: ownKeyRun, cancelToken: "tok-1" },
          }),
        }),
      ),
      model((next) => expect(next.runTokens).toEqual({ "run-own": "tok-1" })),
      Command.expectHas(
        SaveRunTokens({ runTokens: { "run-own": "tok-1" } }),
        NavigateInternal({ url: runHref("run-own") }),
      ),
      Command.resolveAll(
        [SaveRunTokens, Message.CompletedSaveRunTokens()],
        [NavigateInternal, Message.CompletedNavigateInternal()],
      ),
    );
  });

  it("the run page cancels with this browser's token for that run", () => {
    const runPage: Model = {
      ...home,
      route: AppRoute.Run({ runId: "run-own" }),
      page: Page.Run({ run: Run.init("run-own").model }),
      apiKey: "bench-key",
      runTokens: { "run-own": "tok-1" },
    };

    story(
      update,
      given(runPage),
      message(Message.GotRunMessage({ message: Run.Message.ClickedCancel() })),
      Command.expectHas(
        Run.CancelRun({ runId: "run-own", auth: CancelAuth.RunToken({ token: "tok-1" }) }),
      ),
      Command.resolve(
        Run.CancelRun,
        Run.Message.SucceededCancelRun({ run: { ...ownKeyRun, status: "cancelled" } }),
      ),
    );
  });

  it("without a token for the run, the bench key cancels it", () => {
    const runPage: Model = {
      ...home,
      route: AppRoute.Run({ runId: "run-server" }),
      page: Page.Run({ run: Run.init("run-server").model }),
      apiKey: "bench-key",
      runTokens: { "run-own": "tok-1" },
    };

    story(
      update,
      given(runPage),
      message(Message.GotRunMessage({ message: Run.Message.ClickedCancel() })),
      Command.expectHas(
        Run.CancelRun({ runId: "run-server", auth: CancelAuth.BenchKey({ apiKey: "bench-key" }) }),
      ),
      Command.resolve(Run.CancelRun, Run.Message.FailedCancelRun({ error: "nope" })),
    );
  });
});
