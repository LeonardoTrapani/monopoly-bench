/** "Now": turn, round, the frame stack and who must act (with the reasons they were woken). */
import { Pending, pending, type GameState, type Seat } from "@mb/engine";
import clsx from "clsx";
import { Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { frameLabel, wakeReasonDescription, wakeReasonLabel } from "../../../domain/wake.ts";
import { seatToken } from "../../../view/ui.ts";

const doneSeats = (state: GameState): ReadonlyArray<Seat> => {
  const frame = state.control.stack.at(-1);

  if (frame === undefined) return [];

  return Match.value(frame).pipe(
    Match.withReturnType<ReadonlyArray<Seat>>(),
    Match.tag("Table", "RaiseFunds", "Auction", "BuildingAuction", (roundFrame) => roundFrame.done),
    Match.orElse(() => []),
  );
};

const roundOf = (state: GameState): number | null => {
  const frame = state.control.stack.at(-1);

  if (frame === undefined) return null;

  return Match.value(frame).pipe(
    Match.withReturnType<number | null>(),
    Match.tag(
      "Table",
      "RaiseFunds",
      "Auction",
      "BuildingAuction",
      (roundFrame) => roundFrame.round,
    ),
    Match.orElse(() => null),
  );
};

export const statusView = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  liveThinking: ReadonlyArray<Seat>,
  isLive: boolean,
): Html => {
  const now = pending(state);
  const round = roundOf(state);
  const done = doneSeats(state);

  const header = h.div(
    [h.Class("flex flex-wrap items-baseline justify-between gap-2")],
    [
      h.p(
        [h.Class("display text-lg text-ink")],
        [
          state.status === "finished" ? "Final position" : `Turn ${state.control.turn}`,
          h.span(
            [h.Class("ml-2 text-sm font-semibold text-muted")],
            [`round ${state.control.gameRound} of ${state.config.rules.maxRounds}`],
          ),
        ],
      ),
      h.p(
        [h.Class("flex flex-wrap items-center gap-1 text-xs text-ink-2")],
        [
          ...state.control.stack.flatMap((frame, index) => [
            index === 0 ? h.empty : h.span([h.Class("text-muted"), h.AriaHidden(true)], ["›"]),
            h.span(
              [h.Class("rounded border border-line bg-paper-2 px-1.5 py-0.5 font-semibold")],
              [frameLabel(frame._tag)],
            ),
          ]),
          round === null ? h.empty : h.span([h.Class("num ml-1 text-muted")], [`round ${round}`]),
        ],
      ),
    ],
  );

  const body = Pending.match(now, {
    Finished: ({ standings: rows }) =>
      h.p(
        [h.Class("text-sm text-ink-2")],
        [`Game over · ${rows.map((row) => `${row.rank}. ${row.seat}`).join("  ")}`],
      ),
    Waiting: ({ requests }) =>
      requests.length === 0
        ? h.p([h.Class("text-sm text-muted")], ["Resolving…"])
        : h.ul(
            [h.Class("flex flex-wrap gap-2")],
            requests.map((request) => {
              const isDone = done.includes(request.seat);
              const isThinking = isLive && liveThinking.includes(request.seat);

              return h.keyed("li")(
                request.seat,
                [
                  h.Class(
                    clsx("flex items-center gap-2 rounded-md border-[1.5px] px-2 py-1", {
                      "border-line bg-paper-2 opacity-60": isDone,
                      "border-red bg-red/5": !isDone,
                    }),
                  ),
                  h.Title(request.question),
                ],
                [
                  seatToken(h, request.seat, "sm"),
                  h.span(
                    [h.Class("text-xs font-semibold text-ink")],
                    [isDone ? "done" : isThinking ? "thinking" : "to act"],
                  ),
                  isThinking && !isDone
                    ? h.span(
                        [h.Class("thinking-dots text-red")],
                        [h.span([]), h.span([]), h.span([])],
                      )
                    : h.empty,
                  ...request.reasons.map((reason) =>
                    h.span(
                      [
                        h.Class(
                          "rounded bg-ink/80 px-1.5 py-px text-[10px] font-bold tracking-wide text-white uppercase",
                        ),
                        h.Title(wakeReasonDescription(reason)),
                      ],
                      [wakeReasonLabel(reason)],
                    ),
                  ),
                ],
              );
            }),
          ),
  });

  return h.div([h.Class("space-y-2")], [header, body]);
};
