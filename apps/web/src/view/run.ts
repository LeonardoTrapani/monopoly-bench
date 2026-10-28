/** Shared pieces of the run pages: seat lineup chips, progress and spend-vs-budget bars. */
import { competitorId, competitorLabel, type RunSummary, type SeatSpec } from "@mb/api";
import { Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { integer, usd } from "../domain/format.ts";
import { providerColor } from "../domain/palette.ts";
import { competitorHref } from "../route.ts";
import { progressBar } from "./ui.ts";

const seatDetail = (seat: SeatSpec): string =>
  Match.valueTags(seat, {
    llm: (llm) =>
      llm.reasoning === undefined || llm.reasoning === "off"
        ? llm.model
        : `${llm.model} · reasoning ${llm.reasoning}`,
    bot: (bot) => `scripted ${bot.policy} bot`,
  });

export const lineupView = <M>(h: HtmlBuilder<M>, seats: ReadonlyArray<SeatSpec>): Html =>
  h.ul(
    [h.Class("flex flex-wrap gap-2")],
    seats.map((seat) =>
      h.li(
        [],
        [
          h.a(
            [
              h.Href(competitorHref(competitorId(seat))),
              h.Class(
                "inline-flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1 text-xs hover:border-line-strong",
              ),
              h.Title(seatDetail(seat)),
            ],
            [
              h.span([
                h.Class("h-2.5 w-2.5 rounded-full"),
                h.Style({ background: providerColor(competitorId(seat)) }),
              ]),
              h.span([h.Class("font-semibold text-ink")], [competitorLabel(seat)]),
            ],
          ),
        ],
      ),
    ),
  );

export const progressView = <M>(h: HtmlBuilder<M>, run: RunSummary): Html =>
  h.div(
    [h.Class("space-y-1")],
    [
      progressBar(
        h,
        run.gamesTotal === 0 ? 0 : run.gamesFinished / run.gamesTotal,
        "var(--color-dark-blue)",
        "Games finished",
      ),
      h.p(
        [h.Class("num text-xs text-muted")],
        [
          `${integer(run.gamesFinished)} / ${integer(run.gamesTotal)} games`,
          run.gamesRunning > 0 ? ` · ${run.gamesRunning} running` : "",
        ],
      ),
    ],
  );

export const budgetView = <M>(h: HtmlBuilder<M>, run: RunSummary): Html => {
  const ratio = run.budgetUsd === 0 ? 0 : run.spentUsd / run.budgetUsd;

  return h.div(
    [h.Class("space-y-1")],
    [
      progressBar(h, ratio, ratio >= 1 ? "var(--red)" : "var(--money)", "Budget spent"),
      h.p([h.Class("num text-xs text-muted")], [`${usd(run.spentUsd)} of ${usd(run.budgetUsd)}`]),
    ],
  );
};
