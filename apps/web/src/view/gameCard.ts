/** A game summary card (status, seats in finishing order, cost), linking to the viewer. */
import type { GameSummary } from "@mb/api";
import clsx from "clsx";
import type { Html, HtmlBuilder } from "foldkit/html";

import { END_REASON_TEXT, ordinal, timestamp, usd } from "../domain/format.ts";
import { gameHref } from "../route.ts";
import { gameStatusBadge, seatToken } from "./ui.ts";

const seatsCell = <M>(h: HtmlBuilder<M>, game: GameSummary): Html =>
  h.ul(
    [h.Class("flex flex-col gap-1")],
    [...game.seats]
      .sort((left, right) => (left.finalRank ?? 99) - (right.finalRank ?? 99))
      .map((seat) =>
        h.keyed("li")(
          seat.seat,
          [h.Class("flex items-center gap-2 text-sm")],
          [
            seatToken(h, seat.seat, "sm"),
            h.span(
              [
                h.Class(
                  clsx(
                    "truncate",
                    seat.bankruptAtTurn === null
                      ? "text-ink"
                      : "text-muted line-through decoration-1",
                  ),
                ),
              ],
              [seat.label],
            ),
            seat.finalRank === null
              ? h.empty
              : h.span(
                  [
                    h.Class(
                      clsx(
                        "num ml-auto shrink-0 text-xs font-bold",
                        seat.finalRank === 1 ? "rounded bg-gold px-1.5 text-ink" : "text-muted",
                      ),
                    ),
                  ],
                  [ordinal(seat.finalRank)],
                ),
          ],
        ),
      ),
  );

export const gameCardView = <M>(h: HtmlBuilder<M>, game: GameSummary): Html => {
  const cost = game.seats.reduce((total, seat) => total + seat.costUsd, 0);

  return h.keyed("li")(
    game.id,
    [],
    [
      h.a(
        [
          h.Href(gameHref(game.id)),
          h.Class(
            "deed grid gap-4 p-4 transition hover:-translate-y-0.5 hover:shadow-[6px_6px_0_var(--shadow)] sm:grid-cols-[10rem_1fr_9rem]",
          ),
        ],
        [
          h.div(
            [h.Class("space-y-1.5")],
            [
              gameStatusBadge(h, game.status),
              h.p([h.Class("display text-lg text-ink")], [`${game.playersCount} players`]),
              h.p([h.Class("num text-xs text-muted")], [`turn ${game.turn} · round ${game.round}`]),
            ],
          ),
          seatsCell(h, game),
          h.div(
            [h.Class("space-y-1 text-xs text-muted sm:text-right")],
            [
              h.p([], [game.startedAt === null ? "not started" : timestamp(game.startedAt)]),
              game.endReason === null ? h.empty : h.p([], [END_REASON_TEXT[game.endReason]]),
              h.p([h.Class("num")], [cost === 0 ? "bots only" : `${usd(cost)} spent`]),
              h.p(
                [h.Class("font-semibold text-red")],
                [game.status === "running" ? "Watch live →" : "Replay →"],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};
