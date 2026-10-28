/** The game viewer page: board, players, now, timeline, tabs (table, reasoning, log), net worth. */
import type { GameSummary } from "@mb/api";
import clsx from "clsx";
import { Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { timestamp } from "../../../domain/format.ts";
import { turnIndexAt } from "../../../domain/replay.ts";
import { gamesRouter, runHref } from "../../../route.ts";
import { deedCard, errorView, gameStatusBadge, loadingView } from "../../../view/ui.ts";
import { Message } from "../message.ts";
import { Connection, Timeline, type Model, type ReadyTimeline, type Tab } from "../model.ts";
import { isLiveStatus } from "../update.ts";
import { boardView } from "./board.ts";
import { logView } from "./log.ts";
import { playersView } from "./players.ts";
import { reasoningView } from "./reasoning.ts";
import { statusView } from "./status.ts";
import { tableView } from "./table.ts";
import { timelineView, worthChartView } from "./timeline.ts";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["Table", "Table & offers"],
  ["Reasoning", "Reasoning"],
  ["Log", "Event log"],
];

const END_REASON_TEXT: Readonly<Record<NonNullable<GameSummary["endReason"]>, string>> = {
  lastPlayerStanding: "last player standing",
  turnCap: "ended at the turn cap",
  aborted: "aborted",
};

const shortId = (gameId: string): string =>
  gameId.length > 14 ? `${gameId.slice(0, 12)}…` : gameId;

export const title = (model: Model): string =>
  AsyncData.matchData(model.summary, {
    onEmpty: () => `Game ${shortId(model.gameId)}`,
    onFailure: () => `Game ${shortId(model.gameId)}`,
    onData: (summary) =>
      `${isLiveStatus(summary.status) ? "Live: " : ""}${summary.seats.map((seat) => seat.label).join(" vs ")}`,
  });

const connectionNote = (h: HtmlBuilder<Message>, connection: Connection): Html =>
  Connection.match(connection, {
    Offline: () => h.empty,
    Connecting: () => h.span([h.Class("text-xs text-muted")], ["connecting…"]),
    Open: () => h.span([h.Class("text-xs font-semibold text-money")], ["● streaming"]),
    Lost: ({ error }) =>
      h.span(
        [h.Class("text-xs font-semibold text-red"), h.Title(error)],
        ["connection lost, retrying…"],
      ),
  });

const headerView = (h: HtmlBuilder<Message>, model: Model, summary: GameSummary | null): Html =>
  h.div(
    [h.Class("flex flex-wrap items-end justify-between gap-3")],
    [
      h.div(
        [h.Class("min-w-0")],
        [
          h.nav(
            [h.Class("text-xs text-muted"), h.AriaLabel("Breadcrumb")],
            [
              h.a([h.Href(gamesRouter()), h.Class("font-semibold hover:text-red")], ["Games"]),
              " / ",
              h.span([h.Class("num")], [shortId(model.gameId)]),
            ],
          ),
          h.h1(
            [h.Class("display mt-1 truncate text-2xl text-ink sm:text-3xl")],
            [
              summary === null
                ? `Game ${shortId(model.gameId)}`
                : `${summary.playersCount}-player game`,
            ],
          ),
        ],
      ),
      summary === null
        ? h.empty
        : h.div(
            [h.Class("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2")],
            [
              gameStatusBadge(h, summary.status),
              connectionNote(h, model.connection),
              h.span([h.Class("num")], [`seed ${summary.seed}`]),
              h.a(
                [h.Href(runHref(summary.runId)), h.Class("font-semibold hover:text-red")],
                ["run →"],
              ),
              summary.startedAt === null
                ? h.empty
                : h.span([], [`started ${timestamp(summary.startedAt)}`]),
              summary.endReason === null
                ? h.empty
                : h.span([], [END_REASON_TEXT[summary.endReason]]),
            ],
          ),
    ],
  );

const tabsView = (h: HtmlBuilder<Message>, model: Model): Html =>
  h.div(
    [
      h.Class("flex gap-1 border-b-[1.5px] border-line-strong"),
      h.Role("tablist"),
      h.AriaLabel("Game details"),
    ],
    TABS.map(([tab, label]) =>
      h.keyed("button")(
        `tab-${tab}`,
        [
          h.Type("button"),
          h.Role("tab"),
          h.AriaSelected(model.tab === tab),
          h.Class(
            clsx("-mb-[1.5px] rounded-t-md border-[1.5px] px-3 py-1.5 text-sm font-semibold", {
              "border-line-strong border-b-paper bg-paper text-ink": model.tab === tab,
              "border-transparent text-muted hover:text-ink": model.tab !== tab,
            }),
          ),
          h.OnClick(Message.SelectedTab({ tab })),
        ],
        [label],
      ),
    ),
  );

const readyView = (
  h: HtmlBuilder<Message>,
  model: Model,
  timeline: ReadyTimeline,
  summary: GameSummary | null,
): Html => {
  const { replay, cursor, current } = timeline;
  const state = current.state;
  const turnPosition = turnIndexAt(replay, cursor);
  const isLive = summary !== null && isLiveStatus(summary.status);
  const lastEvent = cursor > 0 ? replay.events[cursor - 1] : undefined;
  const appliedEvents = replay.events.slice(0, cursor);
  const thinkingSeats = model.liveWakes.filter((wake) => !wake.isFinished).map((wake) => wake.seat);
  const showLive = isLive && model.isFollowingLive;

  const tokens = state.players.map((player, index) => ({
    seat: player.seat,
    position: player.position,
    laps: current.laps[index] ?? 0,
    isJailed: player.inJail,
    isActive: state.status === "playing" && state.control.activeSeat === player.seat,
    isBankrupt: player.bankrupt,
  }));

  const tabBody = (): Html => {
    if (model.tab === "Reasoning") {
      return reasoningView(h, {
        transcripts: model.transcripts,
        liveWakes: model.liveWakes,
        turn: state.control.turn,
        seats: replay.config.seats,
        seatFilter: model.seatFilter,
        hasLlmSeats: replay.config.seats.some((seat) => !seat.competitorId.startsWith("bot:")),
        isFollowingLive: showLive,
        onFilter: (value) => Message.SelectedSeatFilter({ value }),
        retry: Message.ClickedRetry(),
      });
    }

    if (model.tab === "Log") return logView(h, replay, cursor, turnPosition);

    return tableView(h, state, appliedEvents, (turn) => {
      const position = replay.turns.findIndex((mark) => mark.turn === turn);

      return position < 0 ? null : Message.ClickedTurn({ position });
    });
  };

  return h.div(
    [h.Class("space-y-6")],
    [
      h.div(
        [h.Class("grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")],
        [
          h.div(
            [h.Class("space-y-4")],
            [
              h.div(
                [h.Class("deed p-2 sm:p-3")],
                [boardView(h, { state, tokens, motion: model.motion, lastEvent })],
              ),
              h.div(
                [h.Class("deed p-3")],
                [timelineView(h, model, replay, cursor, turnPosition, isLive)],
              ),
            ],
          ),
          h.div(
            [h.Class("space-y-4")],
            [
              h.div(
                [h.Class("deed p-3")],
                [statusView(h, state, showLive ? thinkingSeats : [], showLive)],
              ),
              playersView(
                h,
                state,
                summary,
                showLive
                  ? model.liveWakes
                      .filter((wake) => !wake.isFinished)
                      .map((wake) => ({ seat: wake.seat, text: "thinking" }))
                  : [],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")],
        [
          h.div(
            [],
            [
              tabsView(h, model),
              h.div([h.Class("deed rounded-t-none border-t-0 p-4")], [tabBody()]),
            ],
          ),
          deedCard(h, { kicker: "Time-limit valuation", title: "Net worth over time" }, [
            worthChartView(h, replay, turnPosition),
          ]),
        ],
      ),
    ],
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const summary = Option.getOrNull(AsyncData.getData(model.summary));

  return h.div(
    [h.Class("mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6")],
    [
      headerView(h, model, summary),
      AsyncData.matchData(model.summary, {
        onEmpty: () => h.empty,
        onData: () => h.empty,
        onFailure: (error) => errorView(h, error, Message.ClickedRetry()),
      }),
      Timeline.match(model.timeline, {
        Loading: () =>
          h.div(
            [h.Class("grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]")],
            [
              h.div([h.Class("deed aspect-square animate-pulse bg-board")]),
              loadingView(h, "Loading the game…", 6),
            ],
          ),
        Failed: ({ error }) => errorView(h, error, Message.ClickedRetry()),
        Ready: (timeline) => readyView(h, model, timeline, summary),
      }),
    ],
  );
});
