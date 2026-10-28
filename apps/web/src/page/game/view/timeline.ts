/** Timeline scrubber (by turn, with markers), playback controls and the net worth chart. */
import clsx from "clsx";
import type { Html, HtmlBuilder } from "foldkit/html";

import { moneyCompact } from "../../../domain/format.ts";
import { SEAT_COLORS } from "../../../domain/palette.ts";
import { worthsOf, type MarkerKind, type Replay } from "../../../domain/replay.ts";
import { lineChart } from "../../../view/charts.ts";
import { Message } from "../message.ts";
import { SPEEDS, type Model } from "../model.ts";

const MARKER_STYLE: ReadonlyArray<readonly [MarkerKind, string, string]> = [
  ["Bankruptcy", "#d32027", "Bankruptcy"],
  ["Trade", "#1b9e52", "Trade"],
  ["Auction", "#2f6fde", "Auction won"],
];

const markerOf = (
  kinds: ReadonlyArray<MarkerKind>,
): readonly [MarkerKind, string, string] | undefined =>
  MARKER_STYLE.find(([kind]) => kinds.includes(kind));

const controlButton = (
  h: HtmlBuilder<Message>,
  label: string,
  message: Message,
  icon: string,
  isDisabled = false,
): Html =>
  h.button(
    [
      h.Type("button"),
      h.AriaLabel(label),
      h.Title(label),
      h.Disabled(isDisabled),
      h.Class(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border-[1.5px] border-line-strong bg-paper text-ink shadow-[2px_2px_0_var(--shadow)] hover:bg-paper-2 disabled:opacity-40",
      ),
      h.OnClick(message),
    ],
    [
      h.svg(
        [h.ViewBox("0 0 24 24"), h.Class("h-4 w-4"), h.Fill("currentColor"), h.AriaHidden(true)],
        [h.path([h.D(icon)])],
      ),
    ],
  );

const ICON_START = "M6 5h2v14H6zM20 5v14L9 12z";

const ICON_BACK = "M18 5v14L7 12zM5 5h2v14H5z";

const ICON_PLAY = "M7 4v16l13-8z";

const ICON_PAUSE = "M6 4h4v16H6zM14 4h4v16h-4z";

const ICON_FORWARD = "M6 5v14l11-7zM17 5h2v14h-2z";

const ICON_END = "M4 5v14l11-7zM16 5h2v14h-2z";

export const timelineView = (
  h: HtmlBuilder<Message>,
  model: Model,
  replay: Replay,
  cursor: number,
  turnPosition: number,
  isLive: boolean,
): Html => {
  const lastPosition = Math.max(0, replay.turns.length - 1);
  const current = replay.turns[turnPosition];
  const isAtEnd = cursor >= replay.events.length;

  return h.div(
    [h.Class("space-y-2")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center gap-2")],
        [
          controlButton(h, "Jump to start", Message.ClickedJumpToStart(), ICON_START, cursor === 0),
          controlButton(h, "Step back", Message.ClickedStepBack(), ICON_BACK, cursor === 0),
          model.playback === "Playing"
            ? controlButton(h, "Pause", Message.ClickedPause(), ICON_PAUSE)
            : controlButton(
                h,
                isAtEnd && !isLive ? "Replay from the start" : "Play",
                Message.ClickedPlay(),
                ICON_PLAY,
                isAtEnd && isLive,
              ),
          controlButton(h, "Step forward", Message.ClickedStepForward(), ICON_FORWARD, isAtEnd),
          controlButton(h, "Jump to end", Message.ClickedJumpToEnd(), ICON_END, isAtEnd),
          h.div(
            [
              h.Class(
                "ml-1 inline-flex rounded-md border-[1.5px] border-line-strong bg-paper p-0.5",
              ),
              h.Role("group"),
              h.AriaLabel("Playback speed"),
            ],
            SPEEDS.map((speed) =>
              h.keyed("button")(
                `speed-${speed}`,
                [
                  h.Type("button"),
                  h.AriaPressed(speed === model.speed ? "true" : "false"),
                  h.Class(
                    clsx(
                      "num rounded px-2 py-1 text-xs font-bold",
                      speed === model.speed ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2",
                    ),
                  ),
                  h.OnClick(Message.SelectedSpeed({ speed })),
                ],
                [`${speed}×`],
              ),
            ),
          ),
          isLive
            ? h.button(
                [
                  h.Type("button"),
                  h.Class(
                    clsx(
                      "inline-flex items-center gap-1.5 rounded-md border-[1.5px] px-2.5 py-1.5 text-xs font-bold",
                      model.isFollowingLive
                        ? "border-red bg-red text-white"
                        : "border-red text-red hover:bg-red/10",
                    ),
                  ),
                  h.AriaPressed(model.isFollowingLive ? "true" : "false"),
                  h.OnClick(Message.ClickedFollowLive()),
                ],
                [
                  h.span([h.Class(clsx("live-dot", { "!bg-white": model.isFollowingLive }))]),
                  model.isFollowingLive ? "Following live" : "Follow live",
                ],
              )
            : h.empty,
          h.p(
            [h.Class("num ml-auto text-sm font-semibold text-ink")],
            [
              current === undefined ? "Setup" : `Turn ${current.turn}`,
              h.span([h.Class("font-normal text-muted")], [` / ${replay.turns.at(-1)?.turn ?? 0}`]),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class("relative pt-3")],
        [
          h.div(
            [h.Class("pointer-events-none absolute inset-x-[9px] top-0 h-3")],
            replay.turns.flatMap((mark, position) => {
              const marker = markerOf(mark.markers);

              if (marker === undefined) return [];

              const [kind, color, label] = marker;
              const left = lastPosition === 0 ? 0 : (position / lastPosition) * 100;

              return [
                h.keyed("button")(`marker-${mark.turn}`, [
                  h.Type("button"),
                  h.Class(
                    clsx(
                      "pointer-events-auto absolute top-0 w-1.5 -translate-x-1/2 rounded-sm hover:scale-150",
                      kind === "Bankruptcy" ? "h-3" : "h-2",
                    ),
                  ),
                  h.Style({ left: `${left}%`, background: color }),
                  h.Title(`Turn ${mark.turn}: ${label}`),
                  h.AriaLabel(`Jump to turn ${mark.turn} (${label})`),
                  h.OnClick(Message.ClickedTurn({ position })),
                ]),
              ];
            }),
          ),
          h.input([
            h.Type("range"),
            h.Class("scrub"),
            h.Min("0"),
            h.Max(`${lastPosition}`),
            h.Step("1"),
            h.Value(`${turnPosition}`),
            h.AriaLabel("Turn"),
            h.AriaValuetext(current === undefined ? "Setup" : `Turn ${current.turn}`),
            h.OnInput((value) => Message.ChangedScrubber({ value })),
          ]),
        ],
      ),
      h.div(
        [h.Class("flex flex-wrap gap-3 text-[11px] text-muted")],
        MARKER_STYLE.map(([kind, color, label]) =>
          h.keyed("span")(
            kind,
            [h.Class("inline-flex items-center gap-1")],
            [
              h.span([
                h.Class("inline-block h-2 w-1.5 rounded-sm"),
                h.Style({ background: color }),
              ]),
              label,
            ],
          ),
        ),
      ),
    ],
  );
};

/** Net worth of every seat at the start of each turn, plus the latest state. */
export const worthChartView = (
  h: HtmlBuilder<Message>,
  replay: Replay,
  turnPosition: number,
): Html => {
  const seats = replay.config.seats;
  const finalTurn = (replay.turns.at(-1)?.turn ?? 0) + 1;
  const headWorths = worthsOf(replay.head.state);
  const isFinished = replay.head.state.status === "finished";

  const series = seats.map((seat, index) => {
    const finalPoint: readonly [number, number] = [finalTurn, headWorths[index] ?? 0];

    return {
      key: seat.seat,
      label: seat.seat,
      color: SEAT_COLORS[seat.seat],
      points: [
        ...replay.turns.map((mark): readonly [number, number] => [
          mark.turn,
          mark.worths[index] ?? 0,
        ]),
        ...(isFinished ? [finalPoint] : []),
      ],
    };
  });

  return h.div(
    [h.Class("space-y-2")],
    [
      lineChart(h, {
        width: 640,
        height: 260,
        series,
        xLabel: "turn",
        formatX: (value) => `${Math.round(value)}`,
        formatY: moneyCompact,
        cursorX: replay.turns[turnPosition]?.turn ?? null,
        ariaLabel: "Net worth of each seat over the game",
        bands: replay.turns.map((mark, position) => ({
          x: mark.turn,
          tooltip: `Turn ${mark.turn}: ${seats.map((seat, index) => `${seat.seat} ${moneyCompact(mark.worths[index] ?? 0)}`).join(" · ")}`,
          onClick: Message.ClickedTurn({ position }),
        })),
      }),
      h.ul(
        [h.Class("flex flex-wrap gap-x-4 gap-y-1 text-xs")],
        seats.map((seat) =>
          h.keyed("li")(
            seat.seat,
            [h.Class("inline-flex items-center gap-1.5 text-ink-2")],
            [
              h.span([
                h.Class("inline-block h-0.5 w-4 rounded"),
                h.Style({ background: SEAT_COLORS[seat.seat] }),
              ]),
              h.span([h.Class("font-bold text-ink")], [seat.seat]),
              seat.label,
            ],
          ),
        ),
      ),
    ],
  );
};
