/** Shared pieces of the run pages: seat lineup chips, who pays, progress and spend vs budget. */
import {
  competitorId,
  competitorLabel,
  type RunFunding,
  type RunSummary,
  type SeatSpec,
} from "@mb/api";
import { Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { integer, usd } from "../domain/format.ts";
import { competitorHref } from "../route.ts";
import { competitorIcon } from "./provider.ts";
import { pill, progressBar } from "./ui.ts";

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
                "inline-flex items-center gap-1.5 rounded-md border border-line bg-paper py-1 pr-2 pl-1 text-xs hover:border-line-strong",
              ),
              h.Title(seatDetail(seat)),
            ],
            [
              competitorIcon(h, competitorId(seat), "xs"),
              h.span([h.Class("font-semibold text-ink")], [competitorLabel(seat)]),
            ],
          ),
        ],
      ),
    ),
  );

/** Who pays for a run's model calls, in a sentence. */
export const fundingText = (funding: RunFunding): string =>
  funding === "ownKey"
    ? "Paid with the creator's own OpenRouter key."
    : "Paid with server credit (bench API key).";

/** A small pill: "Own key" or "Server credit". */
export const fundingBadge = <M>(h: HtmlBuilder<M>, funding: RunFunding): Html =>
  funding === "ownKey"
    ? pill(h, "Paid with own key", "border border-line bg-paper text-ink-2")
    : pill(h, "Server credit", "border border-line bg-paper text-ink-2");

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
