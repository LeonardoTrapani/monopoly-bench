import { Equal, Option } from "effect";
import { Update } from "foldkit";
import { UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString } from "foldkit/url";

import type { Api } from "./api/api.ts";
import {
  FetchLiveGames,
  LoadExternal,
  NavigateInternal,
  SaveTheme,
  WaitBeforeLivePoll,
} from "./command.ts";
import { failWith, reload, succeedWith } from "./domain/remote.ts";
import { initPage } from "./init.ts";
import { Message } from "./message.ts";
import { Page, type Model } from "./model.ts";
import * as Competitor from "./page/competitor.ts";
import * as Game from "./page/game/index.ts";
import * as Games from "./page/games.ts";
import * as Home from "./page/home.ts";
import * as NewRun from "./page/newRun.ts";
import * as Run from "./page/run.ts";
import * as Runs from "./page/runs.ts";
import { runHref, urlToAppRoute } from "./route.ts";

type UpdateReturn = Update.Return<Model, Message, Api>;

type Step = Update.Step<Model, Message, Api>;

const writePage = (model: Model, page: Page): Model => modifyFields(model, { page: () => page });

const foldHome = Update.foldChild({
  update: Home.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { Home: ({ home }) => Option.some(home) }, () => Option.none()),
  write: (model, nextHome) => writePage(model, Page.Home({ home: nextHome })),
  toParentMessage: (message) => Message.GotHomeMessage({ message }),
});

const foldGames = Update.foldChild({
  update: Games.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { Games: ({ games }) => Option.some(games) }, () => Option.none()),
  write: (model, nextGames) => writePage(model, Page.Games({ games: nextGames })),
  toParentMessage: (message) => Message.GotGamesMessage({ message }),
});

const foldGame = Update.foldChild({
  update: Game.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { Game: ({ game }) => Option.some(game) }, () => Option.none()),
  write: (model, nextGame) => writePage(model, Page.Game({ game: nextGame })),
  toParentMessage: (message) => Message.GotGameMessage({ message }),
});

const foldCompetitor = Update.foldChild({
  update: Competitor.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { Competitor: ({ competitor }) => Option.some(competitor) }, () =>
      Option.none(),
    ),
  write: (model, nextCompetitor) =>
    writePage(model, Page.Competitor({ competitor: nextCompetitor })),
  toParentMessage: (message) => Message.GotCompetitorMessage({ message }),
});

const foldRuns = Update.foldChild({
  update: Runs.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { Runs: ({ runs }) => Option.some(runs) }, () => Option.none()),
  write: (model, nextRuns) => writePage(model, Page.Runs({ runs: nextRuns })),
  toParentMessage: (message) => Message.GotRunsMessage({ message }),
});

const foldRun = (apiKey: string) =>
  Update.foldChild({
    update: (run: Run.Model, message: Run.Message) => Run.update(run, message, apiKey),
    read: (model: Model) =>
      Page.matchOrElse(model.page, { Run: ({ run }) => Option.some(run) }, () => Option.none()),
    write: (model, nextRun) => writePage(model, Page.Run({ run: nextRun })),
    toParentMessage: (message) => Message.GotRunMessage({ message }),
  });

const foldNewRunOutMessage = NewRun.OutMessage.match<Step>({
  SavedApiKey:
    ({ apiKey }) =>
    (model) => ({ model: modifyFields(model, { apiKey: () => apiKey }) }),
  CreatedRun:
    ({ runId }) =>
    (model) => ({ model, commands: [NavigateInternal({ url: runHref(runId) })] }),
});

const foldNewRun = Update.foldChild({
  update: NewRun.update,
  read: (model: Model) =>
    Page.matchOrElse(model.page, { NewRun: ({ newRun }) => Option.some(newRun) }, () =>
      Option.none(),
    ),
  write: (model, nextNewRun) => writePage(model, Page.NewRun({ newRun: nextNewRun })),
  toParentMessage: (message) => Message.GotNewRunMessage({ message }),
  foldOutMessage: foldNewRunOutMessage,
});

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    ChangedUrl: ({ url }) => {
      const nextRoute = urlToAppRoute(url);

      if (Equal.equals(nextRoute, model.route)) return { model };

      const page = initPage(nextRoute, model.apiKey);

      return {
        model: modifyFields(model, { route: () => nextRoute, page: () => page.model }),
        commands: page.commands ?? [],
      };
    },

    ClickedToggleTheme: () => {
      const theme = model.theme === "Light" ? "Dark" : "Light";

      return {
        model: modifyFields(model, { theme: () => theme }),
        commands: [SaveTheme({ theme })],
      };
    },
    CompletedSaveTheme: () => ({ model }),

    SucceededFetchLiveGames: ({ response }) => ({
      model: modifyFields(model, { liveGames: succeedWith(response) }),
      commands: [WaitBeforeLivePoll()],
    }),
    FailedFetchLiveGames: ({ error }) => ({
      model: modifyFields(model, { liveGames: failWith(error) }),
      commands: [WaitBeforeLivePoll()],
    }),
    CompletedWaitBeforeLivePoll: () => ({
      model: modifyFields(model, { liveGames: reload }),
      commands: [FetchLiveGames()],
    }),

    GotHomeMessage: ({ message }) => foldHome(model, message),
    GotGamesMessage: ({ message }) => foldGames(model, message),
    GotGameMessage: ({ message }) => foldGame(model, message),
    GotCompetitorMessage: ({ message }) => foldCompetitor(model, message),
    GotRunsMessage: ({ message }) => foldRuns(model, message),
    GotRunMessage: ({ message }) => foldRun(model.apiKey)(model, message),
    GotNewRunMessage: ({ message }) => foldNewRun(model, message),
  });
