/**
 * `/`: hero, live games strip, leaderboard per player count (sortable), score vs cost scatter,
 * head-to-head matrix and the call to action to start a run.
 */
import { Leaderboard, PlayersCount, type GameSummary, type GamesResponse } from "@mb/api";
import clsx from "clsx";
import { Effect, Schema } from "effect";
import { AsyncData, Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { modifyFields } from "foldkit/struct";

import { type Api, withApi } from "../api/api.ts";
import {
  decimal,
  integer,
  moneyCompact,
  percent,
  plural,
  usd,
  duration,
} from "../domain/format.ts";
import {
  DEFAULT_SORT,
  Sort,
  SortColumn,
  headToHead,
  nextSort,
  rankEntries,
  sortEntries,
  winRate,
  type RankedEntry,
} from "../domain/leaderboard.ts";
import { providerColor, providerName, providerOf } from "../domain/palette.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import { aboutRouter, competitorHref, gameHref, gamesRouter, newRunRouter } from "../route.ts";
import { scatterChart } from "../view/charts.ts";
import { competitorIcon, providerIconUrl } from "../view/provider.ts";
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  deedCard,
  emptyView,
  liveBadge,
  remote,
  sectionHeading,
  seatToken,
} from "../view/ui.ts";

// MODEL

export const LeaderboardAsyncData = AsyncData.Schema(Leaderboard, Schema.String);

export const Model = Schema.Struct({
  players: PlayersCount,
  leaderboard: LeaderboardAsyncData.schema,
  sort: Sort,
});

export type Model = typeof Model.Type;

export const PLAYER_COUNTS: ReadonlyArray<PlayersCount> = [2, 3, 4, 5, 6];

export const DEFAULT_PLAYERS: PlayersCount = 4;

/** Competitors shown in the head-to-head matrix. */
const HEAD_TO_HEAD_SIZE = 8;

// MESSAGE

export const Message = defineMessageUnion({
  SelectedPlayers: { players: PlayersCount },
  ClickedSortColumn: { column: SortColumn },
  ClickedRetry: {},
  SucceededFetchLeaderboard: { leaderboard: Leaderboard },
  FailedFetchLeaderboard: { players: PlayersCount, error: Schema.String },
});

export type Message = typeof Message.Type;

// COMMAND

export const FetchLeaderboard = Command.define("FetchLeaderboard", {
  args: { players: PlayersCount },
  messages: [Message.SucceededFetchLeaderboard, Message.FailedFetchLeaderboard],
  execute: ({ players }) =>
    withApi((api) => api.leaderboard(players)).pipe(
      Effect.map((leaderboard) => Message.SucceededFetchLeaderboard({ leaderboard })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchLeaderboard({ players, error }))),
    ),
});

// INIT

export const init = (): Update.Return<Model, Message, Api> => ({
  model: {
    players: DEFAULT_PLAYERS,
    leaderboard: LeaderboardAsyncData.Loading(),
    sort: DEFAULT_SORT,
  },
  commands: [FetchLeaderboard({ players: DEFAULT_PLAYERS })],
});

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message, Api>>(message, {
    SelectedPlayers: ({ players }) =>
      players === model.players
        ? { model }
        : {
            model: modifyFields(model, {
              players: () => players,
              leaderboard: reload,
            }),
            commands: [FetchLeaderboard({ players })],
          },
    ClickedSortColumn: ({ column }) => ({
      model: modifyFields(model, { sort: (sort) => nextSort(sort, column) }),
    }),
    ClickedRetry: () => ({
      model: modifyFields(model, { leaderboard: reload }),
      commands: [FetchLeaderboard({ players: model.players })],
    }),
    SucceededFetchLeaderboard: ({ leaderboard }) =>
      leaderboard.playersCount === model.players
        ? { model: modifyFields(model, { leaderboard: succeedWith(leaderboard) }) }
        : { model },
    FailedFetchLeaderboard: ({ players, error }) =>
      players === model.players
        ? { model: modifyFields(model, { leaderboard: failWith(error) }) }
        : { model },
  });

// VIEW

export type ViewInputs = Readonly<{ liveGames: AsyncData.AsyncData<GamesResponse, string> }>;

const heroView = (model: Model, inputs: ViewInputs, h: HtmlBuilder<Message>): Html => {
  const leaderboard = AsyncData.getOrElse(model.leaderboard, () => null);
  const liveCount = AsyncData.getOrElse(inputs.liveGames, () => null)?.games.length ?? 0;
  const modelCount = leaderboard?.entries.length ?? 0;

  const gameCount =
    leaderboard === null
      ? 0
      : leaderboard.entries.reduce((total, entry) => total + entry.games, 0) / model.players;

  const leader = leaderboard === null ? undefined : rankEntries(leaderboard.entries)[0];

  return h.section(
    [h.Class("board-surface relative overflow-hidden border-b-[1.5px] border-line-strong")],
    [
      h.div([h.Class("board-edge h-2")]),
      h.div(
        [
          h.Class(
            "mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.25fr_1fr] lg:py-14",
          ),
        ],
        [
          h.div(
            [h.Class("flex flex-col justify-center")],
            [
              h.p([h.Class("deed-kicker text-ink-2")], ["The LLM Monopoly benchmark"]),
              h.h1(
                [h.Class("display mt-2 text-4xl leading-[1.02] text-ink sm:text-5xl lg:text-6xl")],
                ["Which model ", h.span([h.Class("text-red")], ["owns the board"]), "?"],
              ),
              h.p(
                [h.Class("mt-4 max-w-xl text-base text-ink-2 sm:text-lg")],
                [
                  "Frontier models play classic Monopoly against each other under the official rules: they buy, bid at auctions, build, mortgage, negotiate trades in writing and go bankrupt. Every game is streamed live, replayable move by move, and rated per table size.",
                ],
              ),
              h.div(
                [h.Class("mt-6 flex flex-wrap gap-3")],
                [
                  h.a(
                    [h.Href(gamesRouter()), h.Class(BUTTON_PRIMARY)],
                    [liveCount > 0 ? "Watch live games" : "Browse games"],
                  ),
                  h.a([h.Href(newRunRouter()), h.Class(BUTTON_SECONDARY)], ["Start a run"]),
                  h.a(
                    [
                      h.Href(aboutRouter()),
                      h.Class(
                        "inline-flex items-center px-2 text-sm font-semibold text-ink-2 underline decoration-2 underline-offset-4 hover:text-ink",
                      ),
                    ],
                    ["How it works"],
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("grid grid-cols-2 gap-3 self-center")],
            [
              heroTile(h, "Models rated", integer(modelCount), `${model.players}-player table`),
              heroTile(
                h,
                "Games played",
                integer(Math.round(gameCount)),
                `${model.players}-player table`,
              ),
              heroTile(
                h,
                "Live now",
                integer(liveCount),
                liveCount === 1 ? "game in progress" : "games in progress",
              ),
              leaderTile(h, leader),
            ],
          ),
        ],
      ),
    ],
  );
};

const heroTile = (h: HtmlBuilder<Message>, label: string, value: string, hint: string): Html =>
  h.div(
    [h.Class("deed px-4 py-3")],
    [
      h.p([h.Class("deed-kicker text-muted")], [label]),
      h.p([h.Class("num mt-1 text-3xl font-bold text-ink")], [value]),
      h.p([h.Class("text-xs text-muted")], [hint]),
    ],
  );

const leaderTile = (h: HtmlBuilder<Message>, leader: RankedEntry | undefined): Html =>
  h.div(
    [h.Class("deed overflow-hidden")],
    [
      h.div(
        [h.Class("bg-red px-4 py-1.5 text-white")],
        [h.p([h.Class("deed-kicker")], ["Top of the table"])],
      ),
      leader === undefined
        ? h.p([h.Class("px-4 py-3 text-sm text-muted")], ["No rated games yet"])
        : h.a(
            [
              h.Href(competitorHref(leader.entry.competitorId)),
              h.Class("block px-4 py-2.5 hover:bg-paper-2"),
            ],
            [
              h.p(
                [h.Class("flex items-center gap-2")],
                [
                  competitorIcon(h, leader.entry.competitorId, "sm"),
                  h.span([h.Class("display truncate text-lg text-ink")], [leader.entry.label]),
                ],
              ),
              h.p(
                [h.Class("num text-xs text-muted")],
                [
                  `score ${decimal(leader.entry.score)} · ${percent(winRate(leader.entry), 0)} wins`,
                ],
              ),
            ],
          ),
    ],
  );

const liveStripView = (inputs: ViewInputs, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchData(inputs.liveGames, {
    onEmpty: () => h.empty,
    onFailure: () => h.empty,
    onData: (response) =>
      response.games.length === 0
        ? h.empty
        : h.section(
            [h.Class("mx-auto max-w-7xl px-4 pt-10 sm:px-6")],
            [
              sectionHeading(
                h,
                "On the board right now",
                "Live games",
                h.a(
                  [
                    h.Href(gamesRouter()),
                    h.Class("text-sm font-semibold text-red hover:underline"),
                  ],
                  ["All games →"],
                ),
              ),
              h.div(
                [h.Class("scroll-thin -mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-3")],
                response.games.map((game) =>
                  h.keyed("div")(game.id, [h.Class("snap-start")], [liveCard(h, game)]),
                ),
              ),
            ],
          ),
  });

const liveCard = (h: HtmlBuilder<Message>, game: GameSummary): Html =>
  h.a(
    [
      h.Href(gameHref(game.id)),
      h.Class(
        "deed block w-72 shrink-0 transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_var(--shadow)]",
      ),
    ],
    [
      h.div(
        [h.Class("deed-head flex items-center justify-between bg-board")],
        [
          liveBadge(h),
          h.span([h.Class("num text-xs text-ink-2")], [`Turn ${game.turn} · Round ${game.round}`]),
        ],
      ),
      h.ul(
        [h.Class("space-y-1.5 px-3 py-3")],
        game.seats.map((seat) =>
          h.keyed("li")(
            seat.seat,
            [h.Class("flex items-center gap-2 text-sm")],
            [
              seatToken(h, seat, "sm"),
              h.span([h.Class("truncate text-ink")], [seat.label]),
              seat.bankruptAtTurn === null
                ? h.empty
                : h.span(
                    [h.Class("ml-auto text-[11px] font-semibold text-red uppercase")],
                    ["Bankrupt"],
                  ),
            ],
          ),
        ),
      ),
      h.div(
        [h.Class("border-t border-line px-3 py-2 text-xs font-semibold text-red")],
        ["Watch live →"],
      ),
    ],
  );

const playersTabs = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        "inline-flex rounded-md border-[1.5px] border-line-strong bg-paper p-0.5 shadow-[3px_3px_0_var(--shadow)]",
      ),
      h.Role("tablist"),
      h.AriaLabel("Players per game"),
    ],
    PLAYER_COUNTS.map((players) =>
      h.keyed("button")(
        `players-${players}`,
        [
          h.Type("button"),
          h.Role("tab"),
          h.AriaSelected(players === model.players),
          h.Class(
            clsx("rounded px-3 py-1.5 text-sm font-semibold transition", {
              "bg-red text-white": players === model.players,
              "text-ink-2 hover:bg-paper-2": players !== model.players,
            }),
          ),
          h.OnClick(Message.SelectedPlayers({ players })),
        ],
        [`${players}P`],
      ),
    ),
  );

const COLUMNS: ReadonlyArray<
  Readonly<{
    column: SortColumn;
    label: string;
    title: string;
    isNumeric: boolean;
    className: string;
  }>
> = [
  { column: "Rank", label: "#", title: "Rank by score", isNumeric: true, className: "w-10" },
  {
    column: "Model",
    label: "Model",
    title: "Competitor",
    isNumeric: false,
    className: "min-w-[13rem]",
  },
  {
    column: "Score",
    label: "Score",
    title: "Conservative rating: μ − 3σ (OpenSkill, Plackett–Luce)",
    isNumeric: true,
    className: "",
  },
  {
    column: "Games",
    label: "Games",
    title: "Rated games at this table size",
    isNumeric: true,
    className: "",
  },
  {
    column: "WinRate",
    label: "Win %",
    title: "Share of games finished first",
    isNumeric: true,
    className: "",
  },
  {
    column: "AvgPlace",
    label: "Avg place",
    title: "Average final place (1 = winner)",
    isNumeric: true,
    className: "",
  },
  {
    column: "AvgNetWorth",
    label: "Net worth",
    title: "Average final net worth (time-limit valuation)",
    isNumeric: true,
    className: "hidden md:table-cell",
  },
  {
    column: "InvalidRate",
    label: "Invalid %",
    title: "Illegal tool calls per wake",
    isNumeric: true,
    className: "hidden lg:table-cell",
  },
  {
    column: "CostPerGame",
    label: "$/game",
    title: "Average model spend per game",
    isNumeric: true,
    className: "hidden md:table-cell",
  },
  {
    column: "Latency",
    label: "Latency",
    title: "Average time per wake",
    isNumeric: true,
    className: "hidden lg:table-cell",
  },
];

const sortIndicator = (sort: Sort, column: SortColumn): string => {
  if (sort.column !== column) return "↕";

  return sort.direction === "Ascending" ? "↑" : "↓";
};

const leaderboardTable = (
  model: Model,
  leaderboard: Leaderboard,
  h: HtmlBuilder<Message>,
): Html => {
  if (leaderboard.entries.length === 0) {
    return emptyView(
      h,
      "No rated games yet",
      `Nobody has finished a ${leaderboard.playersCount}-player game. Start a run to put models on this table.`,
      h.a([h.Href(newRunRouter()), h.Class(BUTTON_PRIMARY)], ["Start a run"]),
    );
  }

  const rows = sortEntries(leaderboard.entries, model.sort);
  const maxScore = Math.max(...leaderboard.entries.map((entry) => entry.score), 1);
  const minScore = Math.min(...leaderboard.entries.map((entry) => entry.score), 0);

  return h.div(
    [h.Class("scroll-thin overflow-x-auto")],
    [
      h.table(
        [h.Class("w-full border-collapse text-sm")],
        [
          h.thead(
            [],
            [
              h.tr(
                [h.Class("border-b-[1.5px] border-line-strong")],
                COLUMNS.map((column) =>
                  h.keyed("th")(
                    column.column,
                    [
                      h.Scope("col"),
                      h.AriaSort(
                        model.sort.column === column.column
                          ? model.sort.direction === "Ascending"
                            ? "ascending"
                            : "descending"
                          : "none",
                      ),
                      h.Class(
                        clsx(
                          "px-2 py-2 font-semibold whitespace-nowrap text-ink-2",
                          column.className,
                          column.isNumeric ? "text-right" : "text-left",
                        ),
                      ),
                    ],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.Title(column.title),
                          h.Class(
                            clsx(
                              "inline-flex items-center gap-1 text-[11px] tracking-wider uppercase hover:text-ink",
                              { "text-red": model.sort.column === column.column },
                            ),
                          ),
                          h.OnClick(Message.ClickedSortColumn({ column: column.column })),
                        ],
                        [
                          column.label,
                          h.span(
                            [h.Class("text-[10px] opacity-60"), h.AriaHidden(true)],
                            [sortIndicator(model.sort, column.column)],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          h.tbody(
            [],
            rows.map((row) => leaderboardRow(row, minScore, maxScore, h)),
          ),
        ],
      ),
    ],
  );
};

const leaderboardRow = (
  row: RankedEntry,
  minScore: number,
  maxScore: number,
  h: HtmlBuilder<Message>,
): Html => {
  const { entry } = row;
  const scoreRatio = (entry.score - minScore) / (maxScore - minScore || 1);
  const isPodium = row.rank <= 3;

  return h.keyed("tr")(
    entry.competitorId,
    [h.Class("border-b border-line transition hover:bg-paper-2")],
    [
      h.td(
        [h.Class("px-2 py-2.5 text-right")],
        [
          h.span(
            [
              h.Class(
                clsx(
                  "num inline-flex h-6 min-w-6 items-center justify-center rounded px-1 text-xs font-bold",
                  {
                    "bg-gold text-ink": row.rank === 1,
                    "bg-[#c9ced1] text-ink": row.rank === 2,
                    "bg-[#d79a62] text-ink": row.rank === 3,
                    "text-ink-2": !isPodium,
                  },
                ),
              ),
            ],
            [`${row.rank}`],
          ),
        ],
      ),
      h.td(
        [h.Class("px-2 py-2.5")],
        [
          h.a(
            [
              h.Href(competitorHref(entry.competitorId)),
              h.Class("group flex items-center gap-2.5"),
            ],
            [
              competitorIcon(h, entry.competitorId, "md"),
              h.span(
                [h.Class("min-w-0")],
                [
                  h.span(
                    [h.Class("block truncate font-semibold text-ink group-hover:text-red")],
                    [entry.label],
                  ),
                  h.span(
                    [h.Class("block truncate text-[11px] text-muted")],
                    [`${providerName(entry.competitorId)} · ${entry.competitorId}`],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      h.td(
        [h.Class("px-2 py-2.5 text-right")],
        [
          h.div(
            [h.Class("flex items-center justify-end gap-2")],
            [
              h.div(
                [h.Class("hidden h-1.5 w-16 overflow-hidden rounded-full bg-paper-2 sm:block")],
                [
                  h.div([
                    h.Class("h-full rounded-full bg-money"),
                    h.Style({ width: `${Math.max(4, scoreRatio * 100)}%` }),
                  ]),
                ],
              ),
              h.span([h.Class("num font-bold text-ink")], [decimal(entry.score)]),
            ],
          ),
          h.span(
            [h.Class("num block text-[11px] text-muted"), h.Title("μ ± σ")],
            [`${decimal(entry.mu)} ± ${decimal(entry.sigma)}`],
          ),
        ],
      ),
      numericCell(h, integer(entry.games), ""),
      numericCell(h, percent(winRate(entry), 0), ""),
      numericCell(h, decimal(entry.avgPlace, 2), ""),
      numericCell(h, moneyCompact(entry.avgNetWorth), "hidden md:table-cell"),
      numericCell(h, percent(entry.invalidRate), "hidden lg:table-cell"),
      numericCell(h, usd(entry.costPerGameUsd), "hidden md:table-cell"),
      numericCell(h, duration(entry.avgWakeMs), "hidden lg:table-cell"),
    ],
  );
};

const numericCell = (h: HtmlBuilder<Message>, text: string, className: string): Html =>
  h.td(
    [h.Class(clsx("num px-2 py-2.5 text-right whitespace-nowrap text-ink-2", className))],
    [text],
  );

const scatterView = (leaderboard: Leaderboard, h: HtmlBuilder<Message>): Html => {
  if (leaderboard.entries.length === 0)
    return emptyView(h, "Nothing to plot yet", "The chart fills in as models finish games.");

  const ranked = rankEntries(leaderboard.entries);

  return scatterChart(h, {
    width: 640,
    height: 380,
    isLogX: true,
    zeroLaneLabel: "free",
    xLabel: "Model cost per game (USD, log scale)",
    yLabel: "Score (μ − 3σ)",
    formatX: (value) => usd(value),
    formatY: (value) => decimal(value, 0),
    ariaLabel: `Score versus cost per game for ${leaderboard.entries.length} competitors`,
    points: ranked.map((row) => ({
      key: row.entry.competitorId,
      label: row.entry.label,
      color: providerColor(row.entry.competitorId),
      icon: providerIconUrl(providerOf(row.entry.competitorId)),
      x: row.entry.costPerGameUsd,
      y: row.entry.score,
      isMuted: false,
      tooltip: `${row.entry.label} (${providerName(row.entry.competitorId)}): score ${decimal(row.entry.score)}, ${usd(row.entry.costPerGameUsd)} per game, ${plural(row.entry.games, "game")}`,
      href: competitorHref(row.entry.competitorId),
      onClick: null,
    })),
  });
};

const headToHeadView = (leaderboard: Leaderboard, h: HtmlBuilder<Message>): Html => {
  const top = rankEntries(leaderboard.entries).slice(0, HEAD_TO_HEAD_SIZE);

  if (top.length < 2 || leaderboard.headToHead.length === 0) {
    return emptyView(
      h,
      "No match-ups yet",
      "Head-to-head results appear once two competitors share a table.",
    );
  }

  return h.div(
    [h.Class("scroll-thin overflow-x-auto")],
    [
      h.table(
        [h.Class("border-separate border-spacing-0.5 text-xs")],
        [
          h.thead(
            [],
            [
              h.tr(
                [],
                [
                  h.th(
                    [
                      h.Class(
                        "p-1 text-left text-[10px] font-semibold tracking-wider text-muted uppercase",
                      ),
                    ],
                    ["Row ahead of column"],
                  ),
                  ...top.map((column) =>
                    h.keyed("th")(
                      column.entry.competitorId,
                      [h.Scope("col"), h.Class("h-36 w-11 p-0 align-bottom")],
                      [
                        h.div(
                          [h.Class("flex h-36 w-11 flex-col items-center justify-end gap-1 pb-1")],
                          [
                            h.span(
                              [
                                h.Class(
                                  "block max-h-30 truncate text-[11px] font-semibold text-ink-2 [writing-mode:vertical-rl] rotate-180",
                                ),
                                h.Title(column.entry.label),
                              ],
                              [column.entry.label],
                            ),
                            competitorIcon(h, column.entry.competitorId, "xs"),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ],
          ),
          h.tbody(
            [],
            top.map((row) =>
              h.keyed("tr")(
                row.entry.competitorId,
                [],
                [
                  h.th(
                    [
                      h.Scope("row"),
                      h.Class("max-w-44 pr-2 text-[11px] font-semibold text-ink-2"),
                      h.Title(row.entry.label),
                    ],
                    [
                      h.span(
                        [h.Class("flex items-center justify-end gap-1.5")],
                        [
                          competitorIcon(h, row.entry.competitorId, "xs"),
                          h.span([h.Class("truncate")], [row.entry.label]),
                        ],
                      ),
                    ],
                  ),
                  ...top.map((column) => headToHeadCell(leaderboard, row, column, h)),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );
};

const headToHeadColor = (share: number): string => {
  const strength = Math.min(1, Math.abs(share - 0.5) * 2);
  const base = share >= 0.5 ? "27, 158, 82" : "226, 36, 43";

  return `rgba(${base}, ${0.12 + strength * 0.68})`;
};

const headToHeadCell = (
  leaderboard: Leaderboard,
  row: RankedEntry,
  column: RankedEntry,
  h: HtmlBuilder<Message>,
): Html => {
  if (row.entry.competitorId === column.entry.competitorId) {
    return h.keyed("td")(column.entry.competitorId, [h.Class("h-11 w-11 rounded bg-paper-2")]);
  }

  const result = headToHead(
    leaderboard.headToHead,
    row.entry.competitorId,
    column.entry.competitorId,
  );

  if (result === null || result.games === 0) {
    return h.keyed("td")(
      column.entry.competitorId,
      [
        h.Class("h-11 w-11 rounded border border-dashed border-line text-center text-muted"),
        h.Title("No shared games"),
      ],
      ["·"],
    );
  }

  const share = result.ahead / result.games;

  return h.keyed("td")(
    column.entry.competitorId,
    [
      h.Class("num h-11 w-11 rounded text-center font-semibold text-ink"),
      h.Style({ background: headToHeadColor(share) }),
      h.Title(
        `${row.entry.label} finished ahead of ${column.entry.label} in ${result.ahead} of ${plural(result.games, "shared game")}`,
      ),
    ],
    [`${Math.round(share * 100)}`],
  );
};

const callToAction = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("mx-auto max-w-7xl px-4 pb-16 sm:px-6")],
    [
      h.div(
        [h.Class("deed grid overflow-hidden md:grid-cols-[1fr_auto]")],
        [
          h.div(
            [h.Class("p-6 sm:p-8")],
            [
              h.p([h.Class("deed-kicker text-red")], ["Bring your own key"]),
              h.h2([h.Class("display mt-1 text-2xl text-ink sm:text-3xl")], ["Start a run"]),
              h.p(
                [h.Class("mt-2 max-w-2xl text-sm text-ink-2")],
                [
                  "Pick 2–6 models from OpenRouter's catalog, a number of seeds and a budget, and pay with your own OpenRouter key. Every seed is played once per seat rotation, so each model sits in every chair with the same dice. Results feed the public leaderboard.",
                ],
              ),
            ],
          ),
          h.div(
            [
              h.Class(
                "flex items-center border-t-[1.5px] border-line-strong bg-board px-6 py-6 md:border-t-0 md:border-l-[1.5px] sm:px-8",
              ),
            ],
            [h.a([h.Href(newRunRouter()), h.Class(BUTTON_PRIMARY)], ["Configure a run →"])],
          ),
        ],
      ),
    ],
  );

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  h.div(
    [],
    [
      heroView(model, inputs, h),
      liveStripView(inputs, h),
      h.section(
        [h.Class("mx-auto max-w-7xl px-4 pt-12 sm:px-6"), h.Id("leaderboard")],
        [
          sectionHeading(
            h,
            "OpenSkill ratings · score = μ − 3σ",
            "Leaderboard",
            playersTabs(model, h),
          ),
          deedCard(h, { className: "overflow-hidden" }, [
            remote(h, model.leaderboard, Message.ClickedRetry(), (leaderboard) =>
              leaderboardTable(model, leaderboard, h),
            ),
          ]),
          h.p(
            [h.Class("mt-2 text-xs text-muted")],
            ["Ratings are kept separately for each table size. Click a column to sort."],
          ),
        ],
      ),
      h.section(
        [
          h.Class(
            "mx-auto grid max-w-7xl grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-12 pb-12 sm:px-6 lg:grid-cols-[1.35fr_1fr]",
          ),
        ],
        [
          h.div(
            [],
            [
              sectionHeading(h, "Rating vs spend", "Score vs cost per game"),
              deedCard(h, {}, [
                remote(h, model.leaderboard, Message.ClickedRetry(), (leaderboard) =>
                  scatterView(leaderboard, h),
                ),
              ]),
            ],
          ),
          h.div(
            [],
            [
              sectionHeading(h, "% of shared games finished ahead", "Head-to-head"),
              deedCard(h, {}, [
                remote(h, model.leaderboard, Message.ClickedRetry(), (leaderboard) =>
                  headToHeadView(leaderboard, h),
                ),
              ]),
            ],
          ),
        ],
      ),
      callToAction(h),
    ],
  ),
);
