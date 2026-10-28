/** `/games`: live and finished games with filters by status, player count and model. */
import { GamesResponse, ModelsResponse, PlayersCount } from "@mb/api";
import clsx from "clsx";
import { Effect, Equal, Option, Schema } from "effect";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { GamesQuery, GameListStatus, withApi, type Api } from "../api/api.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import { newRunRouter } from "../route.ts";
import { gameCardView } from "../view/gameCard.ts";
import { BUTTON_PRIMARY, emptyView, remote, sectionHeading } from "../view/ui.ts";

// MODEL

export const GamesAsyncData = AsyncData.Schema(GamesResponse, Schema.String);

export const ModelsAsyncData = AsyncData.Schema(ModelsResponse, Schema.String);

export const Model = Schema.Struct({
  query: GamesQuery,
  games: GamesAsyncData.schema,
  models: ModelsAsyncData.schema,
});

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  SelectedStatus: { value: Schema.String },
  SelectedPlayers: { value: Schema.String },
  SelectedModel: { value: Schema.String },
  ClickedRetry: {},
  SucceededFetchGames: { query: GamesQuery, response: GamesResponse },
  FailedFetchGames: { query: GamesQuery, error: Schema.String },
  SucceededFetchModels: { response: ModelsResponse },
  FailedFetchModels: { error: Schema.String },
});

export type Message = typeof Message.Type;

// COMMAND

export const FetchGames = Command.define("FetchGames", {
  args: { query: GamesQuery },
  messages: [Message.SucceededFetchGames, Message.FailedFetchGames],
  execute: ({ query }) =>
    withApi((api) => api.games(query)).pipe(
      Effect.map((response) => Message.SucceededFetchGames({ query, response })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchGames({ query, error }))),
    ),
});

export const FetchModels = Command.define("FetchModels", {
  messages: [Message.SucceededFetchModels, Message.FailedFetchModels],
  execute: withApi((api) => api.models).pipe(
    Effect.map((response) => Message.SucceededFetchModels({ response })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchModels({ error }))),
  ),
});

// INIT

const initialQuery: GamesQuery = {
  status: Option.none(),
  players: Option.none(),
  model: Option.none(),
};

export const init = (): Update.Return<Model, Message, Api> => ({
  model: {
    query: initialQuery,
    games: GamesAsyncData.Loading(),
    models: ModelsAsyncData.Loading(),
  },
  commands: [FetchGames({ query: initialQuery }), FetchModels()],
});

// UPDATE

const decodeStatus = Schema.decodeUnknownOption(GameListStatus);

const decodePlayers = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(PlayersCount)),
);

const withQuery = (model: Model, query: GamesQuery): Update.Return<Model, Message, Api> =>
  Equal.equals(query, model.query)
    ? { model }
    : {
        model: modifyFields(model, { query: () => query, games: reload }),
        commands: [FetchGames({ query })],
      };

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Api>>(message, {
    SelectedStatus: ({ value }) =>
      withQuery(model, { ...model.query, status: decodeStatus(value) }),
    SelectedPlayers: ({ value }) =>
      withQuery(model, { ...model.query, players: decodePlayers(value) }),
    SelectedModel: ({ value }) =>
      withQuery(model, {
        ...model.query,
        model: value === "" ? Option.none() : Option.some(value),
      }),
    ClickedRetry: () => ({
      model: modifyFields(model, { games: reload }),
      commands: [FetchGames({ query: model.query })],
    }),
    SucceededFetchGames: ({ query, response }) =>
      Equal.equals(query, model.query)
        ? { model: modifyFields(model, { games: succeedWith(response) }) }
        : { model },
    FailedFetchGames: ({ query, error }) =>
      Equal.equals(query, model.query)
        ? { model: modifyFields(model, { games: failWith(error) }) }
        : { model },
    SucceededFetchModels: ({ response }) => ({
      model: modifyFields(model, { models: succeedWith(response) }),
    }),
    FailedFetchModels: ({ error }) => ({ model: modifyFields(model, { models: failWith(error) }) }),
  });

// VIEW

const STATUS_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["", "All"],
  ["live", "Live"],
  ["finished", "Finished"],
];

const selectClass =
  "rounded-md border-[1.5px] border-line-strong bg-paper px-2.5 py-1.5 text-sm font-semibold text-ink shadow-[2px_2px_0_var(--shadow)]";

const filtersView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const status = Option.getOrElse(model.query.status, () => "");
  const competitors = AsyncData.getOrElse(model.models, () => null)?.competitors ?? [];

  return h.div(
    [h.Class("mb-5 flex flex-wrap items-center gap-3")],
    [
      h.div(
        [
          h.Class(
            "inline-flex rounded-md border-[1.5px] border-line-strong bg-paper p-0.5 shadow-[2px_2px_0_var(--shadow)]",
          ),
          h.Role("group"),
          h.AriaLabel("Status"),
        ],
        STATUS_OPTIONS.map(([value, label]) =>
          h.keyed("button")(
            `status-${value}`,
            [
              h.Type("button"),
              h.AriaPressed(status === value ? "true" : "false"),
              h.Class(
                clsx(
                  "rounded px-3 py-1 text-sm font-semibold",
                  status === value ? "bg-red text-white" : "text-ink-2 hover:bg-paper-2",
                ),
              ),
              h.OnClick(Message.SelectedStatus({ value })),
            ],
            [label],
          ),
        ),
      ),
      h.label(
        [h.Class("flex items-center gap-2 text-sm text-ink-2")],
        [
          "Players",
          h.select(
            [h.Class(selectClass), h.OnChange((value) => Message.SelectedPlayers({ value }))],
            [
              h.option([h.Value(""), h.Selected(Option.isNone(model.query.players))], ["Any"]),
              ...[2, 3, 4, 5, 6].map((players) =>
                h.option(
                  [
                    h.Value(`${players}`),
                    h.Selected(Option.contains(model.query.players, players)),
                  ],
                  [`${players} players`],
                ),
              ),
            ],
          ),
        ],
      ),
      h.label(
        [h.Class("flex items-center gap-2 text-sm text-ink-2")],
        [
          "Model",
          h.select(
            [
              h.Class(clsx(selectClass, "max-w-64")),
              h.OnChange((value) => Message.SelectedModel({ value })),
            ],
            [
              h.option([h.Value(""), h.Selected(Option.isNone(model.query.model))], ["Any model"]),
              ...competitors.map((competitor) =>
                h.option(
                  [
                    h.Value(competitor.competitorId),
                    h.Selected(Option.contains(model.query.model, competitor.competitorId)),
                  ],
                  [competitor.label],
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const listView = (model: Model, response: GamesResponse, h: HtmlBuilder<Message>): Html => {
  if (response.games.length === 0) {
    const isLiveFilter = Option.contains(model.query.status, "live");

    return emptyView(
      h,
      isLiveFilter ? "No live games right now" : "No games yet",
      isLiveFilter
        ? "Nothing is being played at the moment. Finished games stay available as replays."
        : "No game matches these filters. Games appear here as soon as a run starts them.",
      h.a([h.Href(newRunRouter()), h.Class(BUTTON_PRIMARY)], ["Start a run"]),
    );
  }

  const games = [...response.games].sort(
    (left, right) => Number(right.status === "running") - Number(left.status === "running"),
  );

  return h.ul(
    [h.Class("space-y-3")],
    games.map((game) => gameCardView(h, game)),
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class("mx-auto max-w-7xl px-4 py-10 sm:px-6")],
    [
      sectionHeading(h, "Every game is replayable", "Games"),
      filtersView(model, h),
      remote(h, model.games, Message.ClickedRetry(), (response) => listView(model, response, h)),
    ],
  ),
);
