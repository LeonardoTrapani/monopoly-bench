/** `/runs/:id`: progress, spend vs budget, lineup and games of one run; cancel with the API key. */
import { RunDetail, RunSummary } from "@mb/api";
import { Duration, Effect, Schema } from "effect";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { withApi, type Api } from "../api/api.ts";
import { integer, timestamp, usd } from "../domain/format.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import { newRunRouter, runsRouter } from "../route.ts";
import { gameCardView } from "../view/gameCard.ts";
import { budgetView, lineupView, progressView } from "../view/run.ts";
import {
  BUTTON_SECONDARY,
  deedCard,
  emptyView,
  remote,
  runStatusBadge,
  sectionHeading,
  stat,
} from "../view/ui.ts";

// MODEL

export const DetailAsyncData = AsyncData.Schema(RunDetail, Schema.String);

export const Cancel = defineTaggedUnion({
  Idle: {},
  Cancelling: {},
  Failed: { error: Schema.String },
});

export type Cancel = typeof Cancel.Type;

export const Model = Schema.Struct({
  runId: Schema.String,
  detail: DetailAsyncData.schema,
  cancel: Cancel,
});

export type Model = typeof Model.Type;

const REFRESH_INTERVAL = Duration.seconds(10);

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRetry: {},
  ClickedCancel: {},
  SucceededFetchRun: { detail: RunDetail },
  FailedFetchRun: { error: Schema.String },
  SucceededCancelRun: { run: RunSummary },
  FailedCancelRun: { error: Schema.String },
  CompletedWaitBeforeRefresh: {},
});

export type Message = typeof Message.Type;

// COMMAND

export const FetchRun = Command.define("FetchRun", {
  args: { runId: Schema.String },
  messages: [Message.SucceededFetchRun, Message.FailedFetchRun],
  execute: ({ runId }) =>
    withApi((api) => api.run(runId)).pipe(
      Effect.map((detail) => Message.SucceededFetchRun({ detail })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchRun({ error }))),
    ),
});

export const CancelRun = Command.define("CancelRun", {
  args: { runId: Schema.String, apiKey: Schema.String },
  messages: [Message.SucceededCancelRun, Message.FailedCancelRun],
  execute: ({ runId, apiKey }) =>
    withApi((api) => api.cancelRun(runId, apiKey)).pipe(
      Effect.map((run) => Message.SucceededCancelRun({ run })),
      Effect.catch((error) => Effect.succeed(Message.FailedCancelRun({ error }))),
    ),
});

export const WaitBeforeRefresh = Command.define("WaitBeforeRefresh", {
  messages: [Message.CompletedWaitBeforeRefresh],
  execute: Effect.sleep(REFRESH_INTERVAL).pipe(Effect.as(Message.CompletedWaitBeforeRefresh())),
});

// INIT

export const init = (runId: string): Update.Return<Model, Message, Api> => ({
  model: { runId, detail: DetailAsyncData.Loading(), cancel: Cancel.Idle() },
  commands: [FetchRun({ runId })],
});

// UPDATE

const isActive = (run: RunSummary): boolean => run.status === "running" || run.status === "queued";

export const update = (model: Model, message: Message, apiKey: string) =>
  Message.match<Update.Return<Model, Message, Api>>(message, {
    ClickedRetry: () => ({
      model: modifyFields(model, { detail: reload }),
      commands: [FetchRun({ runId: model.runId })],
    }),
    ClickedCancel: () =>
      apiKey === ""
        ? {
            model: modifyFields(model, {
              cancel: () =>
                Cancel.Failed({ error: "Add your API key on the Start a run page first." }),
            }),
          }
        : {
            model: modifyFields(model, { cancel: () => Cancel.Cancelling() }),
            commands: [CancelRun({ runId: model.runId, apiKey })],
          },
    SucceededFetchRun: ({ detail }) => ({
      model: modifyFields(model, { detail: succeedWith(detail) }),
      commands: isActive(detail.run) ? [WaitBeforeRefresh()] : [],
    }),
    FailedFetchRun: ({ error }) => ({ model: modifyFields(model, { detail: failWith(error) }) }),
    SucceededCancelRun: ({ run }) => ({
      model: modifyFields(model, {
        cancel: () => Cancel.Idle(),
        detail: AsyncData.map((detail) => ({ ...detail, run })),
      }),
    }),
    FailedCancelRun: ({ error }) => ({
      model: modifyFields(model, { cancel: () => Cancel.Failed({ error }) }),
    }),
    CompletedWaitBeforeRefresh: () => ({
      model: modifyFields(model, { detail: reload }),
      commands: [FetchRun({ runId: model.runId })],
    }),
  });

// VIEW

export type ViewInputs = Readonly<{ hasApiKey: boolean }>;

const cancelView = (
  model: Model,
  run: RunSummary,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  if (!isActive(run)) return h.empty;

  return h.div(
    [h.Class("flex flex-col items-end gap-1")],
    [
      h.button(
        [
          h.Type("button"),
          h.Class(BUTTON_SECONDARY),
          h.Disabled(Cancel.guards.Cancelling(model.cancel)),
          h.OnClick(Message.ClickedCancel()),
        ],
        [Cancel.guards.Cancelling(model.cancel) ? "Cancelling…" : "Cancel run"],
      ),
      Cancel.match(model.cancel, {
        Idle: () =>
          inputs.hasApiKey
            ? h.empty
            : h.a(
                [h.Href(newRunRouter()), h.Class("text-xs text-muted underline")],
                ["Needs your API key"],
              ),
        Cancelling: () => h.empty,
        Failed: ({ error }) =>
          h.p([h.Class("text-xs font-semibold text-red"), h.Role("alert")], [error]),
      }),
    ],
  );
};

const detailView = (
  model: Model,
  detail: RunDetail,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const { run, games } = detail;
  const perGame = run.gamesFinished === 0 ? 0 : run.spentUsd / run.gamesFinished;

  return h.div(
    [h.Class("space-y-8")],
    [
      h.div(
        [h.Class("flex flex-wrap items-end justify-between gap-4")],
        [
          h.div(
            [],
            [
              h.div(
                [h.Class("mb-1 flex items-center gap-2")],
                [
                  runStatusBadge(h, run.status),
                  h.span([h.Class("text-xs text-muted")], [`created ${timestamp(run.createdAt)}`]),
                ],
              ),
              h.h1([h.Class("display text-3xl text-ink")], [run.name ?? "Untitled run"]),
              h.p([h.Class("num text-xs text-muted")], [`${run.id} · ${run.playersCount} players`]),
            ],
          ),
          cancelView(model, run, inputs, h),
        ],
      ),
      h.div(
        [h.Class("grid gap-4 md:grid-cols-3")],
        [
          deedCard(
            h,
            {
              kicker: "Progress",
              title: `${integer(run.gamesFinished)} of ${integer(run.gamesTotal)} games`,
            },
            [progressView(h, run)],
          ),
          h.div(
            [h.Class("banknote p-4")],
            [
              h.p([h.Class("deed-kicker text-money")], ["Spend vs budget"]),
              h.p([h.Class("num mt-1 mb-3 text-2xl font-bold text-ink")], [usd(run.spentUsd)]),
              budgetView(h, run),
            ],
          ),
          deedCard(h, { kicker: "Averages", title: "Per game" }, [
            h.div(
              [h.Class("grid grid-cols-2 gap-3")],
              [
                stat(h, "Model spend", usd(perGame)),
                stat(h, "Running now", integer(run.gamesRunning)),
              ],
            ),
          ]),
        ],
      ),
      h.section(
        [],
        [sectionHeading(h, "Seats rotate every game", "Lineup"), lineupView(h, run.seats)],
      ),
      h.section(
        [],
        [
          sectionHeading(h, "Live first, then latest", "Games"),
          games.length === 0
            ? emptyView(h, "No games yet", "Games appear here when the run starts them.")
            : h.ul(
                [h.Class("space-y-3")],
                [...games]
                  .sort(
                    (left, right) =>
                      Number(right.status === "running") - Number(left.status === "running"),
                  )
                  .map((game) => gameCardView(h, game)),
              ),
        ],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [h.Class("mx-auto max-w-7xl px-4 py-8 sm:px-6")],
    [
      h.nav(
        [h.Class("mb-4 text-xs text-muted"), h.AriaLabel("Breadcrumb")],
        [
          h.a([h.Href(runsRouter()), h.Class("font-semibold hover:text-red")], ["Runs"]),
          " / ",
          h.span([h.Class("num")], [model.runId]),
        ],
      ),
      remote(h, model.detail, Message.ClickedRetry(), (detail) =>
        detailView(model, detail, inputs, h),
      ),
    ],
  ),
);
