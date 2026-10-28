/** The page frame: red wordmark banner with navigation, and the footer. */
import type { GamesResponse } from "@mb/api";
import clsx from "clsx";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { isMockMode } from "../api/layer.ts";
import type { Message } from "../message.ts";
import type { Model } from "../model.ts";
import {
  AppRoute,
  aboutRouter,
  gamesRouter,
  homeRouter,
  newRunRouter,
  runsRouter,
} from "../route.ts";

const isActive = (route: AppRoute, tags: ReadonlyArray<AppRoute["_tag"]>): boolean =>
  AppRoute.isAnyOf(tags)(route);

const navLink = (
  h: HtmlBuilder<Message>,
  href: string,
  label: string,
  active: boolean,
  badge: Html = null,
): Html =>
  h.a(
    [
      h.Href(href),
      h.AriaCurrent(active ? "page" : "false"),
      h.Class(
        clsx(
          "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition",
          active ? "bg-white text-red" : "text-white/90 hover:bg-white/15 hover:text-white",
        ),
      ),
    ],
    [label, badge],
  );

const liveCount = (liveGames: AsyncData.AsyncData<GamesResponse, string>): number =>
  AsyncData.getOrElse(liveGames, () => null)?.games.length ?? 0;

export const wordmark = <M>(h: HtmlBuilder<M>, size: "sm" | "lg" = "sm"): Html =>
  h.span(
    [
      h.Class(
        clsx(
          "wordmark inline-flex items-center gap-2",
          size === "lg" ? "text-4xl sm:text-5xl" : "text-xl sm:text-2xl",
        ),
      ),
    ],
    [
      h.span([h.Class("drop-shadow-[2px_2px_0_rgba(0,0,0,0.35)]")], ["Monopoly"]),
      h.span(
        [
          h.Class(
            clsx(
              "rounded-[3px] bg-white text-red",
              size === "lg" ? "px-2 py-1 text-2xl sm:text-3xl" : "px-1.5 py-0.5 text-[0.62em]",
            ),
          ),
        ],
        ["Bench"],
      ),
    ],
  );

export const header = (model: Model, h: HtmlBuilder<Message>): Html => {
  const live = liveCount(model.liveGames);

  return h.header(
    [
      h.Class(
        "sticky top-0 z-30 border-b-[1.5px] border-line-strong bg-red text-white shadow-[0_2px_0_rgba(0,0,0,0.12)]",
      ),
    ],
    [
      h.div(
        [
          h.Class(
            "mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 sm:flex-nowrap sm:px-6",
          ),
        ],
        [
          h.a(
            [
              h.Href(homeRouter()),
              h.AriaLabel("Monopoly Bench home"),
              h.Class("shrink-0 rounded-md border-2 border-white/90 px-2.5 py-1.5"),
            ],
            [wordmark(h)],
          ),
          h.nav(
            [
              h.Class(
                "scroll-thin order-last -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 py-1 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:px-0",
              ),
              h.AriaLabel("Main"),
            ],
            [
              navLink(
                h,
                homeRouter(),
                "Leaderboard",
                isActive(model.route, ["Home", "Competitor"]),
              ),
              navLink(
                h,
                gamesRouter(),
                "Games",
                isActive(model.route, ["Games", "Game"]),
                live > 0
                  ? h.span(
                      [
                        h.Class(
                          "inline-flex items-center gap-1 rounded-full bg-black/25 px-1.5 text-[11px] text-white",
                        ),
                      ],
                      [h.span([h.Class("live-dot !bg-white")]), `${live}`],
                    )
                  : h.empty,
              ),
              navLink(h, runsRouter(), "Runs", isActive(model.route, ["Runs", "Run"])),
              navLink(h, aboutRouter(), "Methodology", isActive(model.route, ["About"])),
            ],
          ),
          h.div(
            [h.Class("ml-auto flex shrink-0 items-center gap-2")],
            [
              isMockMode
                ? h.span(
                    [
                      h.Class(
                        "hidden rounded bg-black/25 px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase sm:inline",
                      ),
                      h.Title("Served by the in-browser mock API"),
                    ],
                    ["Mock data"],
                  )
                : h.empty,
              h.a(
                [
                  h.Href(newRunRouter()),
                  h.Class(
                    clsx(
                      "hidden rounded-md border-[1.5px] border-line-strong px-3 py-1.5 text-sm font-bold shadow-[2px_2px_0_rgba(0,0,0,0.25)] sm:inline-flex",
                      isActive(model.route, ["NewRun"])
                        ? "bg-ink text-white"
                        : "bg-white text-red hover:bg-paper-2",
                    ),
                  ),
                ],
                ["Start a run"],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

export const footer = (h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class("mt-auto border-t-[1.5px] border-line-strong bg-paper")],
    [
      h.div([h.Class("board-edge h-1.5")]),
      h.div(
        [
          h.Class(
            "mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6",
          ),
        ],
        [
          h.p(
            [h.Class("max-w-3xl")],
            [
              "Monopoly Bench is an independent research benchmark. MONOPOLY is a trademark of Hasbro; this site is not affiliated with or endorsed by Hasbro. The board, cards and artwork here are drawn from scratch.",
            ],
          ),
          h.nav(
            [h.Class("flex gap-4 font-semibold"), h.AriaLabel("Footer")],
            [
              h.a([h.Href(aboutRouter()), h.Class("hover:text-ink")], ["Methodology"]),
              h.a([h.Href(runsRouter()), h.Class("hover:text-ink")], ["Runs"]),
              h.a([h.Href(gamesRouter()), h.Class("hover:text-ink")], ["Games"]),
            ],
          ),
        ],
      ),
    ],
  );
