/** `/runs`: every run with its progress and spend. */
import { RunsResponse, type RunSummary } from "@mb/api";
import { Effect, Schema } from "effect";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { withApi, type Api } from "../api/api.ts";
import { timestamp } from "../domain/format.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import { newRunRouter, runHref } from "../route.ts";
import { budgetView, lineupView, progressView } from "../view/run.ts";
import { BUTTON_PRIMARY, emptyView, remote, runStatusBadge, sectionHeading } from "../view/ui.ts";

// MODEL

export const RunsAsyncData = AsyncData.Schema(RunsResponse, Schema.String);

export const Model = Schema.Struct({ runs: RunsAsyncData.schema });

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRetry: {},
  SucceededFetchRuns: { response: RunsResponse },
  FailedFetchRuns: { error: Schema.String },
});

export type Message = typeof Message.Type;

// COMMAND

export const FetchRuns = Command.define("FetchRuns", {
  messages: [Message.SucceededFetchRuns, Message.FailedFetchRuns],
  execute: withApi((api) => api.runs).pipe(
    Effect.map((response) => Message.SucceededFetchRuns({ response })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchRuns({ error }))),
  ),
});

// INIT

export const init = (): Update.Return<Model, Message, Api> => ({
  model: { runs: RunsAsyncData.Loading() },
  commands: [FetchRuns()],
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Api>>(message, {
    ClickedRetry: () => ({ model: modifyFields(model, { runs: reload }), commands: [FetchRuns()] }),
    SucceededFetchRuns: ({ response }) => ({
      model: modifyFields(model, { runs: succeedWith(response) }),
    }),
    FailedFetchRuns: ({ error }) => ({ model: modifyFields(model, { runs: failWith(error) }) }),
  });

// VIEW

const runRow = (h: HtmlBuilder<Message>, run: RunSummary): Html =>
  h.keyed("li")(
    run.id,
    [],
    [
      h.a(
        [
          h.Href(runHref(run.id)),
          h.Class(
            "deed grid gap-4 p-4 transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_var(--shadow)] md:grid-cols-[1.4fr_1fr_12rem_12rem]",
          ),
        ],
        [
          h.div(
            [h.Class("min-w-0 space-y-1")],
            [
              h.div(
                [h.Class("flex items-center gap-2")],
                [
                  runStatusBadge(h, run.status),
                  h.span([h.Class("text-xs text-muted")], [timestamp(run.createdAt)]),
                ],
              ),
              h.p([h.Class("display truncate text-lg text-ink")], [run.name ?? run.id]),
              h.p(
                [h.Class("num truncate text-xs text-muted")],
                [`${run.playersCount} players · ${run.id}`],
              ),
            ],
          ),
          lineupView(h, run.seats),
          progressView(h, run),
          budgetView(h, run),
        ],
      ),
    ],
  );

const listView = (response: RunsResponse, h: HtmlBuilder<Message>): Html =>
  response.runs.length === 0
    ? emptyView(
        h,
        "No runs yet",
        "A run plays a set of seeds with every seat rotation and feeds the leaderboard.",
        h.a([h.Href(newRunRouter()), h.Class(BUTTON_PRIMARY)], ["Start the first run"]),
      )
    : h.ul(
        [h.Class("space-y-3")],
        response.runs.map((run) => runRow(h, run)),
      );

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class("mx-auto max-w-7xl px-4 py-10 sm:px-6")],
    [
      sectionHeading(
        h,
        "Batches of games",
        "Runs",
        h.a([h.Href(newRunRouter()), h.Class(BUTTON_PRIMARY)], ["Start a run"]),
      ),
      remote(h, model.runs, Message.ClickedRetry(), (response) => listView(response, h)),
    ],
  ),
);
