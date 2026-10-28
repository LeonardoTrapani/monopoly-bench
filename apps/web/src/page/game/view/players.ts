/** The players panel: label, cash, net worth, deeds by color, jail and bankruptcy. */
import type { GameSummary } from "@mb/api";
import {
  GROUP_IDS,
  propertyInfo,
  spaceName,
  standings,
  type GameState,
  type PlayerState,
  type PropertyState,
  type Seat,
} from "@mb/engine";
import clsx from "clsx";
import type { Html, HtmlBuilder } from "foldkit/html";

import { money, ordinal } from "../../../domain/format.ts";
import { worthsOf } from "../../../domain/replay.ts";
import { competitorHref } from "../../../route.ts";
import { deedChip } from "../../../view/deed.ts";
import { competitorIcon } from "../../../view/provider.ts";
import { seatToken } from "../../../view/ui.ts";

export interface SeatActivityHint {
  readonly seat: Seat;
  readonly text: string;
}

const deedsByGroup = (state: GameState, seat: Seat): ReadonlyArray<ReadonlyArray<PropertyState>> =>
  GROUP_IDS.flatMap((group) => {
    const deeds = state.properties.filter(
      (property) => property.owner === seat && propertyInfo(property.id).group === group,
    );

    return deeds.length > 0 ? [deeds] : [];
  });

const statusLine = (player: PlayerState): string => {
  if (player.bankrupt) {
    return player.bankruptcy === null ? "Bankrupt" : `Bankrupt on turn ${player.bankruptcy.turn}`;
  }

  if (player.inJail) return `In jail · attempt ${player.jailAttempts + 1} of 3`;

  return `On ${spaceName(player.position)}`;
};

const playerCard = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  player: PlayerState,
  rank: number,
  worth: number,
  summary: GameSummary | null,
  thinking: SeatActivityHint | undefined,
): Html => {
  const isActive = state.status === "playing" && state.control.activeSeat === player.seat;
  const seatSummary = summary?.seats.find((entry) => entry.seat === player.seat);
  const groups = deedsByGroup(state, player.seat);

  return h.keyed("li")(
    player.seat,
    [
      h.Class(
        clsx("rounded-md border-[1.5px] bg-paper px-3 py-2.5 transition", {
          "border-red shadow-[3px_3px_0_var(--shadow)]": isActive,
          "border-line": !isActive,
          "opacity-55 grayscale": player.bankrupt,
        }),
      ),
    ],
    [
      h.div(
        [h.Class("flex flex-wrap items-start gap-2.5")],
        [
          seatToken(h, player.seat, "md"),
          h.div(
            [h.Class("min-w-0 flex-1")],
            [
              h.div(
                [h.Class("flex items-center gap-1.5")],
                [
                  competitorIcon(h, player.competitorId, "xs"),
                  h.a(
                    [
                      h.Href(competitorHref(player.competitorId)),
                      h.Class("truncate font-semibold text-ink hover:text-red"),
                      h.Title(player.competitorId),
                    ],
                    [player.label],
                  ),
                  h.span(
                    [
                      h.Class("num shrink-0 text-[11px] font-bold text-muted"),
                      h.Title("Current standing"),
                    ],
                    [ordinal(rank)],
                  ),
                  isActive
                    ? h.span(
                        [
                          h.Class(
                            "shrink-0 rounded bg-red px-1.5 text-[10px] font-bold tracking-wider text-white uppercase",
                          ),
                        ],
                        ["Turn"],
                      )
                    : h.empty,
                ],
              ),
              h.p(
                [
                  h.Class(
                    clsx(
                      "truncate text-xs",
                      player.inJail ? "font-semibold text-[#b25e00]" : "text-muted",
                    ),
                  ),
                ],
                [statusLine(player)],
              ),
            ],
          ),
          h.div(
            [h.Class("ml-auto flex shrink-0 gap-1.5")],
            [
              h.div(
                [h.Class("banknote min-w-[4.6rem] px-2 py-0.5 text-right")],
                [
                  h.p(
                    [h.Class("text-[9px] font-semibold tracking-wider text-money uppercase")],
                    ["Cash"],
                  ),
                  h.p([h.Class("num text-sm font-bold text-ink")], [money(player.cash)]),
                ],
              ),
              h.div(
                [
                  h.Class(
                    "min-w-[4.6rem] rounded-md border border-line bg-paper-2 px-2 py-0.5 text-right",
                  ),
                ],
                [
                  h.p(
                    [h.Class("text-[9px] font-semibold tracking-wider text-muted uppercase")],
                    ["Worth"],
                  ),
                  h.p([h.Class("num text-sm font-bold text-ink")], [money(worth)]),
                ],
              ),
            ],
          ),
        ],
      ),
      groups.length === 0
        ? h.empty
        : h.div(
            [h.Class("mt-2 flex flex-wrap gap-1.5")],
            groups.map((deeds) =>
              h.keyed("span")(
                deeds[0]?.id ?? "group",
                [h.Class("inline-flex gap-0.5 rounded bg-paper-2 p-0.5")],
                deeds.map((deed) => deedChip(h, deed)),
              ),
            ),
          ),
      h.div(
        [h.Class("mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted")],
        [
          player.jailCards.length > 0
            ? h.span(
                [h.Class("font-semibold text-ink-2")],
                [
                  player.jailCards.length === 1
                    ? "1 Get Out of Jail Free card"
                    : `${player.jailCards.length} Get Out of Jail Free cards`,
                ],
              )
            : h.empty,
          seatSummary === undefined || seatSummary.kind === "bot"
            ? h.empty
            : h.span(
                [h.Class("num")],
                [
                  `${seatSummary.wakes} wakes · $${seatSummary.costUsd.toFixed(3)} · ${seatSummary.invalidActions} invalid`,
                ],
              ),
          seatSummary === undefined || seatSummary.modelErrors === 0
            ? h.empty
            : h.span(
                [
                  h.Class("num rounded bg-red px-1 font-bold text-white"),
                  h.Title("Wakes that ended because the model call failed: the default was played"),
                ],
                [
                  `${seatSummary.modelErrors} model error${seatSummary.modelErrors === 1 ? "" : "s"}`,
                ],
              ),
          thinking === undefined
            ? h.empty
            : h.span(
                [h.Class("inline-flex items-center gap-1 font-semibold text-red")],
                [
                  h.span([h.Class("thinking-dots")], [h.span([]), h.span([]), h.span([])]),
                  thinking.text,
                ],
              ),
        ],
      ),
    ],
  );
};

export const playersView = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  summary: GameSummary | null,
  thinking: ReadonlyArray<SeatActivityHint>,
): Html => {
  const ranks = standings(state);
  const worths = worthsOf(state);

  return h.ul(
    [h.Class("grid gap-2 md:grid-cols-2 lg:grid-cols-1")],
    state.players.map((player, index) =>
      playerCard(
        h,
        state,
        player,
        ranks.find((row) => row.seat === player.seat)?.rank ?? index + 1,
        worths[index] ?? 0,
        summary,
        thinking.find((hint) => hint.seat === player.seat),
      ),
    ),
  );
};
