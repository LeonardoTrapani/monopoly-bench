/**
 * Shared, stateless view pieces: deed-card panels, badges, seat tokens, and the loading, error
 * and empty states. Every helper takes the caller's `h`, so it works in any page.
 */
import type { GameStatus, RunStatus } from "@mb/api";
import type { Seat } from "@mb/engine";
import clsx from "clsx";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { providerNameOfSlug, providerOf, SEAT_COLORS, SEAT_INK } from "../domain/palette.ts";
import { providerIconUrl, providerInitials } from "./provider.ts";

export const BUTTON_PRIMARY =
  "inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-line-strong bg-red px-4 py-2 text-sm font-semibold text-white shadow-[3px_3px_0_var(--shadow)] transition hover:bg-red-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red active:translate-x-px active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";

export const BUTTON_SECONDARY =
  "inline-flex items-center justify-center gap-2 rounded-md border-[1.5px] border-line-strong bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-[3px_3px_0_var(--shadow)] transition hover:bg-paper-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red active:translate-x-px active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50";

export const BUTTON_GHOST =
  "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium text-ink-2 transition hover:bg-paper-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-red disabled:cursor-not-allowed disabled:opacity-40";

export const LINK =
  "font-medium text-ink underline decoration-line decoration-2 underline-offset-2 hover:decoration-red";

export const INPUT =
  "w-full rounded-md border-[1.5px] border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-red/40";

export const LABEL = "mb-1 block text-xs font-semibold tracking-wide text-ink-2 uppercase";

/** A title-deed card: ink frame, paper, optional colored header band. */
export const deedCard = <M>(
  h: HtmlBuilder<M>,
  config: Readonly<{
    kicker?: string;
    title?: string;
    color?: string;
    ink?: string;
    className?: string;
    aside?: Html;
  }>,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.Class(clsx("deed", config.className))],
    [
      config.title === undefined
        ? h.empty
        : h.header(
            [
              h.Class("deed-head flex items-center justify-between gap-3 text-left"),
              h.Style({
                background: config.color ?? "var(--paper-2)",
                color: config.ink ?? "var(--ink)",
              }),
            ],
            [
              h.div(
                [h.Class("min-w-0")],
                [
                  config.kicker === undefined
                    ? h.empty
                    : h.p([h.Class("deed-kicker opacity-80")], [config.kicker]),
                  h.h2([h.Class("display truncate text-lg leading-tight")], [config.title]),
                ],
              ),
              config.aside ?? h.empty,
            ],
          ),
      h.div([h.Class("p-4")], [...children]),
    ],
  );

/** Section heading with a small uppercase kicker. */
export const sectionHeading = <M>(
  h: HtmlBuilder<M>,
  kicker: string,
  title: string,
  aside: Html = null,
): Html =>
  h.div(
    [h.Class("mb-4 flex flex-wrap items-end justify-between gap-3")],
    [
      h.div(
        [],
        [
          h.p([h.Class("deed-kicker text-red")], [kicker]),
          h.h2([h.Class("display text-2xl text-ink sm:text-3xl")], [title]),
        ],
      ),
      aside,
    ],
  );

/** Who sits in a seat: the seat (its color) and the model playing it (its logo and name). */
export interface SeatPlayer {
  readonly seat: Seat;
  readonly competitorId: string;
  readonly label: string;
}

/** The player of `seat` among `players` (a bare seat if the game has no such player). */
export const seatPlayer = (players: ReadonlyArray<SeatPlayer>, seat: Seat): SeatPlayer =>
  players.find((player) => player.seat === seat) ?? { seat, competitorId: "", label: seat };

/**
 * A round seat token: the model's provider logo on a white disc, ringed with the seat color (two
 * models of one provider stay apart by color). Without a model it shows the seat letter.
 */
export const seatToken = <M>(
  h: HtmlBuilder<M>,
  player: SeatPlayer,
  size: "xs" | "sm" | "md" | "lg" = "md",
): Html => {
  const slug = providerOf(player.competitorId);
  const url = player.competitorId === "" ? null : providerIconUrl(slug);

  return h.span(
    [
      h.Class(
        clsx(
          "inline-flex shrink-0 items-center justify-center rounded-full font-bold leading-none shadow-[0_1px_0_1px_rgba(0,0,0,0.25)] select-none",
          url === null ? "" : "bg-white",
          {
            "h-[18px] w-[18px] border-2 text-[7px]": size === "xs",
            "h-6 w-6 border-[2.5px] text-[9px]": size === "sm",
            "h-8 w-8 border-[3px] text-[11px]": size === "md",
            "h-11 w-11 border-4 text-sm": size === "lg",
          },
        ),
      ),
      h.Style(
        url === null
          ? {
              background: SEAT_COLORS[player.seat],
              color: SEAT_INK[player.seat],
              borderColor: "#ffffff",
            }
          : { borderColor: SEAT_COLORS[player.seat] },
      ),
      h.Title(player.label),
      h.AriaLabel(player.label),
    ],
    [
      url === null
        ? player.competitorId === ""
          ? player.seat
          : providerInitials(providerNameOfSlug(slug))
        : h.img([
            h.Src(url),
            h.Alt(""),
            h.Class(
              clsx({
                "h-2.5 w-2.5": size === "xs",
                "h-3.5 w-3.5": size === "sm",
                "h-[18px] w-[18px]": size === "md",
                "h-6 w-6": size === "lg",
              }),
            ),
            h.Decoding("async"),
          ]),
    ],
  );
};

/** A player named inline in a sentence: their token and model name. */
export const playerTag = <M>(h: HtmlBuilder<M>, player: SeatPlayer): Html =>
  h.span(
    [h.Class("inline-flex max-w-full items-center gap-1 align-middle font-semibold text-ink")],
    [seatToken(h, player, "xs"), h.span([h.Class("truncate")], [player.label])],
  );

/** A list of players named inline (`A, B and C` as tags). */
export const playerTags = <M>(h: HtmlBuilder<M>, players: ReadonlyArray<SeatPlayer>): Html =>
  h.span(
    [h.Class("inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 align-middle")],
    players.map((player) => playerTag(h, player)),
  );

export const pill = <M>(h: HtmlBuilder<M>, text: string, className: string): Html =>
  h.span(
    [
      h.Class(
        clsx(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap uppercase",
          className,
        ),
      ),
    ],
    [text],
  );

export const liveBadge = <M>(h: HtmlBuilder<M>, text = "Live"): Html =>
  h.span(
    [
      h.Class(
        "inline-flex items-center gap-1.5 rounded-full bg-red/10 px-2 py-0.5 text-[11px] font-bold tracking-wide text-red uppercase",
      ),
    ],
    [h.span([h.Class("live-dot")]), text],
  );

export const gameStatusBadge = <M>(h: HtmlBuilder<M>, status: GameStatus): Html => {
  if (status === "running") return liveBadge(h);

  if (status === "finished") return pill(h, "Finished", "bg-money-light text-money");

  if (status === "queued") return pill(h, "Queued", "bg-paper-2 text-muted border border-line");

  if (status === "aborted") return pill(h, "Aborted", "bg-orange/15 text-[#9a5300]");

  return pill(h, "Failed", "bg-red/10 text-red");
};

export const runStatusBadge = <M>(h: HtmlBuilder<M>, status: RunStatus): Html => {
  if (status === "running") return liveBadge(h, "Running");

  if (status === "finished") return pill(h, "Finished", "bg-money-light text-money");

  if (status === "queued") return pill(h, "Queued", "bg-paper-2 text-muted border border-line");

  if (status === "cancelled") return pill(h, "Cancelled", "bg-orange/15 text-[#9a5300]");

  return pill(h, "Failed", "bg-red/10 text-red");
};

/** Skeleton blocks while data loads. */
export const loadingView = <M>(h: HtmlBuilder<M>, label = "Loading…", rows = 4): Html =>
  h.div(
    [h.Class("space-y-2 py-2"), h.Role("status"), h.AriaLabel(label)],
    [
      ...Array.from({ length: rows }, (_, index) =>
        h.div([
          h.Class("h-9 animate-pulse rounded-md bg-paper-2"),
          h.Style({ opacity: `${1 - index * 0.15}` }),
        ]),
      ),
      h.p([h.Class("sr-only")], [label]),
    ],
  );

/** A failed load, with an optional retry button. */
export const errorView = <M>(h: HtmlBuilder<M>, message: string, retry: M | null = null): Html =>
  h.div(
    [
      h.Class(
        "flex flex-wrap items-center justify-between gap-3 rounded-md border-[1.5px] border-red/40 bg-red/5 px-4 py-3 text-sm",
      ),
      h.Role("alert"),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2 text-ink")],
        [h.span([h.Class("font-bold text-red")], ["Could not load."]), h.span([], [message])],
      ),
      retry === null
        ? h.empty
        : h.button([h.Type("button"), h.Class(BUTTON_SECONDARY), h.OnClick(retry)], ["Retry"]),
    ],
  );

/** An empty state: a short title, an explanation and an optional call to action. */
export const emptyView = <M>(
  h: HtmlBuilder<M>,
  title: string,
  body: string,
  action: Html = null,
): Html =>
  h.div(
    [
      h.Class(
        "flex flex-col items-center gap-2 rounded-md border-[1.5px] border-dashed border-line px-6 py-10 text-center",
      ),
    ],
    [
      h.p([h.Class("display text-lg text-ink")], [title]),
      h.p([h.Class("max-w-md text-sm text-muted")], [body]),
      action === null ? h.empty : h.div([h.Class("mt-2")], [action]),
    ],
  );

/** Renders remote data with the shared loading and error states. */
export const remote = <M, A>(
  h: HtmlBuilder<M>,
  data: AsyncData.AsyncData<A, string>,
  retry: M | null,
  onData: (value: A) => Html,
): Html =>
  AsyncData.match(data, {
    onIdle: () => loadingView(h),
    onLoading: () => loadingView(h),
    onRefreshing: (value) => h.div([h.Class("opacity-70 transition-opacity")], [onData(value)]),
    onFailure: (error) => errorView(h, error, retry),
    onStale: ({ data: value, error }) =>
      h.div([h.Class("space-y-3")], [errorView(h, error, retry), onData(value)]),
    onSuccess: onData,
  });

/** A labelled figure: small caps label above a large number. */
export const stat = <M>(
  h: HtmlBuilder<M>,
  label: string,
  value: string,
  hint: string | null = null,
): Html =>
  h.div(
    [h.Class("min-w-0")],
    [
      h.p([h.Class("text-[11px] font-semibold tracking-wider text-muted uppercase")], [label]),
      h.p([h.Class("num truncate text-xl font-semibold text-ink")], [value]),
      hint === null ? h.empty : h.p([h.Class("truncate text-xs text-muted")], [hint]),
    ],
  );

/** A horizontal progress bar; `ratio` is clamped to 0–1. */
export const progressBar = <M>(
  h: HtmlBuilder<M>,
  ratio: number,
  color: string,
  label: string,
): Html =>
  h.div(
    [
      h.Class("h-2.5 w-full overflow-hidden rounded-full border border-line bg-paper-2"),
      h.Role("progressbar"),
      h.AriaLabel(label),
      h.AriaValuemin(0),
      h.AriaValuemax(100),
      h.AriaValuenow(Math.round(Math.max(0, Math.min(1, ratio)) * 100)),
    ],
    [
      h.div([
        h.Class("h-full rounded-full transition-[width] duration-500"),
        h.Style({ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: color }),
      ]),
    ],
  );
