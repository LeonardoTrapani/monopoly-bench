import { Option } from "effect";
import { Command, given, message, model, story } from "foldkit/story";
import { fromString } from "foldkit/url";
import { describe, expect, it } from "vite-plus/test";

import { SaveTheme } from "./command.ts";
import { LiveGamesAsyncData, Page, type Model } from "./model.ts";
import { Message } from "./message.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
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

  it("keeps slashes and colons of competitor ids", () => {
    expect(route("/models/anthropic/claude-sonnet-5.5:high")).toEqual(
      AppRoute.Competitor({ competitorId: "anthropic/claude-sonnet-5.5:high" }),
    );
    expect(route("/models/bot:random")).toEqual(
      AppRoute.Competitor({ competitorId: "bot:random" }),
    );
  });

  it("prints URLs that parse back to the same route", () => {
    const id = "openai/gpt-6.1-sol:high";

    expect(route(competitorHref(id))).toEqual(AppRoute.Competitor({ competitorId: id }));
    expect(route(gameHref("abc"))).toEqual(AppRoute.Game({ gameId: "abc" }));
    expect(route(runHref("r1"))).toEqual(AppRoute.Run({ runId: "r1" }));
    expect(newRunRouter()).toBe("/runs/new");
  });
});

const homeInit = Home.init();

const home: Model = {
  route: AppRoute.Home(),
  page: Page.Home({ home: homeInit.model }),
  theme: "Light",
  apiKey: "",
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

  it("the same URL keeps the page state", () => {
    story(
      update,
      given(home),
      message(Message.ChangedUrl({ url: url("/") })),
      Command.expectNone(),
      model((next) => expect(next.page).toBe(home.page)),
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

  it("toggling the theme saves it", () => {
    story(
      update,
      given(home),
      message(Message.ClickedToggleTheme()),
      model((next) => expect(next.theme).toBe("Dark")),
      Command.resolve(SaveTheme, Message.CompletedSaveTheme()),
    );
  });
});
