/** `/models/:id`: a competitor's ratings per table size, rating history, behavior and recent games. */
import { ModelProfile, type BehaviorStats, type PlayersCount } from "@mb/api";
import clsx from "clsx";
import { Effect, Schema } from "effect";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { withApi, type Api } from "../api/api.ts";
import { day, decimal, duration, integer, percent, usd } from "../domain/format.ts";
import { GROUP_COLORS, providerColor, providerName, reasoningOf } from "../domain/palette.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import { gamesRouter, homeRouter } from "../route.ts";
import { lineChart } from "../view/charts.ts";
import { gameCardView } from "../view/gameCard.ts";
import { competitorIcon } from "../view/provider.ts";
import { deedCard, emptyView, pill, remote, sectionHeading, stat } from "../view/ui.ts";

// MODEL

export const ProfileAsyncData = AsyncData.Schema(ModelProfile, Schema.String);

export const Model = Schema.Struct({
  competitorId: Schema.String,
  profile: ProfileAsyncData.schema,
});

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedRetry: {},
  SucceededFetchProfile: { profile: ModelProfile },
  FailedFetchProfile: { error: Schema.String },
});

export type Message = typeof Message.Type;

// COMMAND

export const FetchProfile = Command.define("FetchProfile", {
  args: { competitorId: Schema.String },
  messages: [Message.SucceededFetchProfile, Message.FailedFetchProfile],
  execute: ({ competitorId }) =>
    withApi((api) => api.model(competitorId)).pipe(
      Effect.map((profile) => Message.SucceededFetchProfile({ profile })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchProfile({ error }))),
    ),
});

// INIT

export const init = (competitorId: string): Update.Return<Model, Message, Api> => ({
  model: { competitorId, profile: ProfileAsyncData.Loading() },
  commands: [FetchProfile({ competitorId })],
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Api>>(message, {
    ClickedRetry: () => ({
      model: modifyFields(model, { profile: reload }),
      commands: [FetchProfile({ competitorId: model.competitorId })],
    }),
    SucceededFetchProfile: ({ profile }) => ({
      model: modifyFields(model, { profile: succeedWith(profile) }),
    }),
    FailedFetchProfile: ({ error }) => ({
      model: modifyFields(model, { profile: failWith(error) }),
    }),
  });

export const title = (model: Model): string =>
  AsyncData.matchData(model.profile, {
    onEmpty: () => model.competitorId,
    onFailure: () => model.competitorId,
    onData: (profile) => profile.label,
  });

// VIEW

const COUNTS: ReadonlyArray<PlayersCount> = [2, 3, 4, 5, 6];

/** One categorical color per table size. */
const COUNT_COLORS: ReadonlyArray<string> = [
  GROUP_COLORS["dark-blue"],
  GROUP_COLORS.green,
  GROUP_COLORS.red,
  GROUP_COLORS.orange,
  GROUP_COLORS.pink,
];

const countColor = (players: PlayersCount): string => COUNT_COLORS[players - 2] ?? GROUP_COLORS.red;

const headerView = (profile: ModelProfile, h: HtmlBuilder<Message>): Html => {
  const reasoning = reasoningOf(profile.competitorId);
  const totalGames = profile.ratings.reduce((total, rating) => total + rating.games, 0);
  const totalWins = profile.ratings.reduce((total, rating) => total + rating.wins, 0);
  const best = [...profile.ratings].sort((left, right) => right.score - left.score)[0];

  return h.section(
    [h.Class("deed overflow-hidden")],
    [
      h.div(
        [
          h.Class(
            "flex flex-wrap items-center gap-4 border-b-[1.5px] border-line-strong px-5 py-4",
          ),
          h.Style({
            background: `color-mix(in oklab, ${providerColor(profile.competitorId)} 14%, var(--paper))`,
          }),
        ],
        [
          competitorIcon(h, profile.competitorId, "lg"),
          h.div(
            [h.Class("min-w-0 flex-1")],
            [
              h.p([h.Class("deed-kicker text-ink-2")], [providerName(profile.competitorId)]),
              h.h1([h.Class("display truncate text-3xl text-ink")], [profile.label]),
              h.p([h.Class("num truncate text-xs text-muted")], [profile.competitorId]),
            ],
          ),
          h.div(
            [h.Class("flex gap-2")],
            [
              reasoning === null
                ? h.empty
                : pill(h, `reasoning: ${reasoning}`, "border border-line bg-paper text-ink-2"),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-5")],
        [
          stat(
            h,
            "Best score",
            best === undefined ? "—" : decimal(best.score),
            best === undefined ? null : `${best.playersCount}-player table`,
          ),
          stat(h, "Games", integer(totalGames)),
          stat(
            h,
            "Wins",
            integer(totalWins),
            totalGames === 0 ? null : percent(totalWins / totalGames, 0),
          ),
          stat(h, "Cost per game", usd(profile.costPerGameUsd)),
          stat(h, "Latency per wake", duration(profile.avgWakeMs)),
        ],
      ),
    ],
  );
};

const ratingsView = (profile: ModelProfile, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5")],
    COUNTS.map((players) => {
      const rating = profile.ratings.find((entry) => entry.playersCount === players);

      return h.keyed("div")(
        `rating-${players}`,
        [h.Class(clsx("deed overflow-hidden", { "opacity-60": rating === undefined }))],
        [
          h.div(
            [h.Class("px-3 py-1.5 text-white"), h.Style({ background: countColor(players) })],
            [h.p([h.Class("deed-kicker")], [`${players} players`])],
          ),
          rating === undefined
            ? h.p([h.Class("px-3 py-4 text-sm text-muted")], ["Not rated yet"])
            : h.div(
                [h.Class("space-y-1 px-3 py-3")],
                [
                  h.p([h.Class("num text-2xl font-bold text-ink")], [decimal(rating.score)]),
                  h.p(
                    [h.Class("num text-xs text-muted")],
                    [`μ ${decimal(rating.mu)} ± ${decimal(rating.sigma)}`],
                  ),
                  h.p(
                    [h.Class("text-xs text-ink-2")],
                    [
                      `${integer(rating.games)} games · ${rating.games === 0 ? "—" : percent(rating.wins / rating.games, 0)} wins`,
                    ],
                  ),
                ],
              ),
        ],
      );
    }),
  );

const historyView = (profile: ModelProfile, h: HtmlBuilder<Message>): Html => {
  if (profile.ratingHistory.length === 0) {
    return emptyView(h, "No rating history yet", "Every rated game adds a point to this chart.");
  }

  const series = COUNTS.flatMap((players) => {
    const points = profile.ratingHistory
      .filter((point) => point.playersCount === players)
      .map((point): readonly [number, number] => [Date.parse(point.at), point.score]);

    return points.length === 0
      ? []
      : [{ key: `${players}`, label: `${players}P`, color: countColor(players), points }];
  });

  return h.div(
    [h.Class("space-y-2")],
    [
      lineChart(h, {
        width: 640,
        height: 260,
        series,
        xLabel: "date",
        formatX: (value) => day(new Date(value).toISOString()),
        formatY: (value) => decimal(value, 0),
        cursorX: null,
        bands: [],
        ariaLabel: `Score history of ${profile.label} per table size`,
      }),
      h.ul(
        [h.Class("flex flex-wrap gap-4 text-xs")],
        series.map((entry) =>
          h.keyed("li")(
            entry.key,
            [h.Class("inline-flex items-center gap-1.5 text-ink-2")],
            [
              h.span([
                h.Class("inline-block h-0.5 w-4 rounded"),
                h.Style({ background: entry.color }),
              ]),
              `${entry.label} table`,
            ],
          ),
        ),
      ),
    ],
  );
};

const behaviorRows = (
  behavior: BehaviorStats,
): ReadonlyArray<readonly [string, string, string | null]> => [
  [
    "Offers made",
    integer(behavior.offersMade),
    behavior.offersMade === 0
      ? null
      : `${percent(behavior.offersAccepted / behavior.offersMade, 0)} accepted`,
  ],
  [
    "Offers received",
    integer(behavior.offersReceived),
    behavior.offersReceived === 0
      ? null
      : `${percent(behavior.offersAcceptedFromOthers / behavior.offersReceived, 0)} accepted`,
  ],
  [
    "Auctions won",
    integer(behavior.auctionsWon),
    behavior.auctionPremium === null ? null : `${decimal(behavior.auctionPremium, 2)}× list price`,
  ],
  ["Deeds bought", integer(behavior.propertiesBought), null],
  ["Houses built", integer(behavior.housesBuilt), `${integer(behavior.hotelsBuilt)} hotels`],
  ["Mortgages", integer(behavior.mortgages), null],
  ["Bankruptcies", integer(behavior.bankruptcies), null],
  ["Turns in jail", integer(behavior.jailTurns), null],
];

const behaviorView = (profile: ModelProfile, h: HtmlBuilder<Message>): Html =>
  h.dl(
    [h.Class("grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4")],
    behaviorRows(profile.behavior).map(([label, value, hint]) =>
      h.keyed("div")(
        label,
        [h.Class("border-l-2 border-red pl-3")],
        [
          h.dt([h.Class("text-[11px] font-semibold tracking-wider text-muted uppercase")], [label]),
          h.dd([h.Class("num text-xl font-semibold text-ink")], [value]),
          hint === null ? h.empty : h.dd([h.Class("text-xs text-muted")], [hint]),
        ],
      ),
    ),
  );

const profileView = (profile: ModelProfile, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("space-y-8")],
    [
      headerView(profile, h),
      h.section(
        [],
        [sectionHeading(h, "Score = μ − 3σ per table size", "Ratings"), ratingsView(profile, h)],
      ),
      h.div(
        [h.Class("grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.2fr_1fr]")],
        [
          deedCard(h, { kicker: "Over time", title: "Rating history" }, [historyView(profile, h)]),
          deedCard(h, { kicker: "How it plays", title: "Behavior" }, [behaviorView(profile, h)]),
        ],
      ),
      h.section(
        [],
        [
          sectionHeading(
            h,
            "Latest first",
            "Recent games",
            h.a(
              [h.Href(gamesRouter()), h.Class("text-sm font-semibold text-red hover:underline")],
              ["All games →"],
            ),
          ),
          profile.recentGames.length === 0
            ? emptyView(h, "No games yet", "This competitor has not finished a game.")
            : h.ul(
                [h.Class("space-y-3")],
                profile.recentGames.map((game) => gameCardView(h, game)),
              ),
        ],
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.Class("mx-auto max-w-7xl px-4 py-8 sm:px-6")],
    [
      h.nav(
        [h.Class("mb-4 text-xs text-muted"), h.AriaLabel("Breadcrumb")],
        [
          h.a([h.Href(homeRouter()), h.Class("font-semibold hover:text-red")], ["Leaderboard"]),
          " / ",
          h.span([h.Class("num")], [model.competitorId]),
        ],
      ),
      remote(h, model.profile, Message.ClickedRetry(), (profile) => profileView(profile, h)),
    ],
  ),
);
