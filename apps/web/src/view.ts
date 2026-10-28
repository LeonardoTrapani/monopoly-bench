import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { Message } from "./message.ts";
import { Page, runCredentials, type Model } from "./model.ts";
import { aboutView } from "./page/about.ts";
import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";
import { homeRouter } from "./route.ts";

import { footer, header } from "./view/layout.ts";
import { BUTTON_PRIMARY } from "./view/ui.ts";

const notFoundView = (path: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("mx-auto flex max-w-xl flex-col items-center px-4 py-24 text-center")],
    [
      h.div(
        [h.Class("deed w-full max-w-sm")],
        [
          h.div(
            [h.Class("deed-head bg-[#f5911e]")],
            [
              h.p([h.Class("deed-kicker")], ["Chance"]),
              h.h1([h.Class("display text-2xl text-ink")], ["Go back 3 spaces"]),
            ],
          ),
          h.div(
            [h.Class("space-y-4 p-6")],
            [
              h.p([h.Class("text-6xl font-black text-[#f5911e]")], ["?"]),
              h.p([h.Class("text-sm text-ink-2")], [`There is no page at “${path}”.`]),
              h.a([h.Href(homeRouter()), h.Class(BUTTON_PRIMARY)], ["Advance to GO"]),
            ],
          ),
        ],
      ),
    ],
  );

const pageTitle = (page: Page): string =>
  Page.match(page, {
    Home: () => "Monopoly Bench · LLMs play classic Monopoly",
    Games: () => "Games · Monopoly Bench",
    Game: ({ game }) => `${Game.title(game)} · Monopoly Bench`,
    Competitor: ({ competitor }) => `${Competitor.title(competitor)} · Monopoly Bench`,
    Runs: () => "Runs · Monopoly Bench",
    Run: () => "Run · Monopoly Bench",
    NewRun: () => "Start a run · Monopoly Bench",
    About: () => "Methodology · Monopoly Bench",
    NotFound: () => "Not found · Monopoly Bench",
  });

const pageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Page.match(model.page, {
    Home: ({ home }) =>
      h.submodel({
        slotId: "home",
        model: home,
        view: Home.view,
        viewInputs: { liveGames: model.liveGames },
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    Games: ({ games }) =>
      h.submodel({
        slotId: "games",
        model: games,
        view: Games.view,
        toParentMessage: (message) => Message.GotGamesMessage({ message }),
      }),
    Game: ({ game }) =>
      h.keyed("div")(
        game.gameId,
        [],
        [
          h.submodel({
            slotId: "game",
            model: game,
            view: Game.view,
            toParentMessage: (message) => Message.GotGameMessage({ message }),
          }),
        ],
      ),
    Competitor: ({ competitor }) =>
      h.submodel({
        slotId: "competitor",
        model: competitor,
        view: Competitor.view,
        toParentMessage: (message) => Message.GotCompetitorMessage({ message }),
      }),
    Runs: ({ runs }) =>
      h.submodel({
        slotId: "runs",
        model: runs,
        view: Runs.view,
        toParentMessage: (message) => Message.GotRunsMessage({ message }),
      }),
    Run: ({ run }) =>
      h.submodel({
        slotId: "run",
        model: run,
        view: Run.view,
        viewInputs: { credentials: runCredentials(model) },
        toParentMessage: (message) => Message.GotRunMessage({ message }),
      }),
    NewRun: ({ newRun }) =>
      h.submodel({
        slotId: "new-run",
        model: newRun,
        view: NewRun.view,
        toParentMessage: (message) => Message.GotNewRunMessage({ message }),
      }),
    About: () => aboutView(h),
    NotFound: ({ path }) => notFoundView(path, h),
  });

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: pageTitle(model.page),
  body: h.div(
    [h.Class("flex min-h-screen flex-col bg-page text-ink")],
    [header(model, h), h.main([h.Class("flex-1")], [pageView(model, h)]), footer(h)],
  ),
});
