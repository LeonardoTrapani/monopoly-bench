/** The "Table" tab: auctions in progress, offers and threads of the session, and past trades. */
import {
  propertyInfo,
  type Assets,
  type EventOf,
  type GameEvent,
  type GameState,
  type Offer,
  type Seat,
} from "@mb/engine";
import clsx from "clsx";
import { Match, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { money } from "../../../domain/format.ts";
import { GROUP_COLORS } from "../../../domain/palette.ts";
import { deedCardView } from "../../../view/deed.ts";
import {
  emptyView,
  pill,
  playerTag,
  playerTags,
  seatPlayer,
  seatToken,
  type SeatPlayer,
} from "../../../view/ui.ts";

const assetsView = <M>(h: HtmlBuilder<M>, assets: Assets): Html => {
  const items: ReadonlyArray<Html> = [
    ...(assets.cash > 0
      ? [
          h.span(
            [h.Class("num rounded bg-money-light px-1.5 py-0.5 text-xs font-bold text-money")],
            [money(assets.cash)],
          ),
        ]
      : []),
    ...assets.properties.map((property) => {
      const info = propertyInfo(property);

      return h.span(
        [
          h.Class(
            "inline-flex items-center gap-1 rounded border border-line bg-paper px-1.5 py-0.5 text-xs font-semibold text-ink",
          ),
        ],
        [
          h.span([
            h.Class("h-2.5 w-2.5 rounded-sm"),
            h.Style({ background: GROUP_COLORS[info.group] }),
          ]),
          info.name,
        ],
      );
    }),
    ...(assets.jailCards > 0
      ? [
          h.span(
            [h.Class("rounded bg-[#f5911e]/20 px-1.5 py-0.5 text-xs font-semibold text-ink")],
            [`${assets.jailCards} jail card${assets.jailCards > 1 ? "s" : ""}`],
          ),
        ]
      : []),
  ];

  return items.length === 0
    ? h.span([h.Class("text-xs text-muted")], ["nothing"])
    : h.span([h.Class("flex flex-wrap gap-1")], [...items]);
};

const offerStatus = <M>(h: HtmlBuilder<M>, offer: Offer): Html => {
  if (offer.status === "open") return pill(h, "Open", "bg-[#2f6fde]/12 text-[#2f6fde]");

  if (offer.status === "accepted") return pill(h, "Accepted", "bg-money-light text-money");

  if (offer.status === "rejected") return pill(h, "Rejected", "bg-red/10 text-red");

  if (offer.status === "withdrawn") return pill(h, "Withdrawn", "bg-paper-2 text-muted");

  return pill(h, "Invalidated", "bg-orange/15 text-[#9a5300]");
};

const quote = <M>(h: HtmlBuilder<M>, player: SeatPlayer, text: string): Html =>
  h.blockquote(
    [
      h.Class(
        "rounded-md border-l-[3px] border-line-strong/40 bg-paper-2 px-2.5 py-1.5 text-xs text-ink-2 italic",
      ),
    ],
    [h.span([h.Class("mr-1 not-italic")], [playerTag(h, player), ":"]), " ", `“${text}”`],
  );

/** The label of one side of a deal: `<player> gives`. */
const sideLabel = <M>(h: HtmlBuilder<M>, player: SeatPlayer, verb: string): Html =>
  h.span(
    [h.Class("inline-flex min-w-0 items-center gap-1 font-semibold text-ink-2")],
    [playerTag(h, player), verb],
  );

const offerCard = <M>(h: HtmlBuilder<M>, offer: Offer, players: ReadonlyArray<SeatPlayer>): Html =>
  h.keyed("li")(
    `offer-${offer.id}`,
    [
      h.Class(
        clsx(
          "rounded-md border-[1.5px] bg-paper p-3",
          offer.status === "open" ? "border-line-strong" : "border-line",
        ),
      ),
    ],
    [
      h.div(
        [h.Class("mb-2 flex flex-wrap items-center gap-2")],
        [
          h.span([h.Class("num text-xs font-bold text-muted")], [`#${offer.id}`]),
          seatToken(h, seatPlayer(players, offer.from), "sm"),
          h.span([h.Class("text-xs text-muted")], ["→"]),
          offer.to === null
            ? pill(h, "Open call", "bg-gold/30 text-ink")
            : seatToken(h, seatPlayer(players, offer.to), "sm"),
          offer.replyTo === null
            ? h.empty
            : h.span([h.Class("text-[11px] text-muted")], [`counter to #${offer.replyTo}`]),
          h.span([h.Class("num text-[11px] text-muted")], [`round ${offer.round}`]),
          h.span([h.Class("ml-auto")], [offerStatus(h, offer)]),
        ],
      ),
      h.div(
        [h.Class("grid items-center gap-1.5 text-xs sm:grid-cols-[auto_1fr]")],
        [
          sideLabel(h, seatPlayer(players, offer.from), "gives"),
          assetsView(h, offer.give),
          sideLabel(h, seatPlayer(players, offer.from), "gets"),
          assetsView(h, offer.get),
        ],
      ),
      offer.comment === null
        ? h.empty
        : h.div([h.Class("mt-2")], [quote(h, seatPlayer(players, offer.from), offer.comment)]),
      offer.messages.length === 0
        ? h.empty
        : h.div(
            [h.Class("mt-2 space-y-1")],
            offer.messages.map((message) =>
              quote(h, seatPlayer(players, message.seat), message.text),
            ),
          ),
      offer.rejectedBy.length === 0
        ? h.empty
        : h.p(
            [h.Class("mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted")],
            [
              "Refused by",
              playerTags(
                h,
                offer.rejectedBy.map((seat) => seatPlayer(players, seat)),
              ),
            ],
          ),
    ],
  );

const auctionPanel = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  events: ReadonlyArray<GameEvent>,
): Html => {
  const frame = state.control.stack.at(-1);

  if (frame === undefined) return h.empty;

  const player = (seat: Seat): SeatPlayer => seatPlayer(state.players, seat);

  const roundsOf = (frameId: number): ReadonlyArray<EventOf<"AuctionRoundClosed">> =>
    events.filter(
      (event): event is EventOf<"AuctionRoundClosed"> =>
        Predicate.isTagged(event, "AuctionRoundClosed") && event.frameId === frameId,
    );

  const bidsTable = (frameId: number): Html =>
    h.ol(
      [h.Class("space-y-1")],
      roundsOf(frameId).map((round) =>
        h.keyed("li")(
          `round-${round.round}`,
          [h.Class("flex flex-wrap items-center gap-1.5 text-xs")],
          [
            h.span([h.Class("num w-16 text-muted")], [`Round ${round.round}`]),
            ...round.bids.map((bid) =>
              h.span(
                [
                  h.Class(
                    clsx(
                      "num inline-flex items-center gap-1 rounded border px-1.5 py-0.5",
                      bid.amount === null
                        ? "border-line text-muted line-through"
                        : "border-line-strong/50 text-ink",
                    ),
                  ),
                ],
                [
                  seatToken(h, player(bid.seat), "xs"),
                  bid.amount === null ? "pass" : money(bid.amount),
                ],
              ),
            ),
          ],
        ),
      ),
    );

  return Match.value(frame).pipe(
    Match.withReturnType<Html>(),
    Match.tag("Auction", (auction) =>
      h.div(
        [
          h.Class(
            "mb-4 grid gap-4 rounded-md border-[1.5px] border-red/50 bg-red/5 p-3 sm:grid-cols-[auto_1fr]",
          ),
        ],
        [
          deedCardView(h, auction.property),
          h.div(
            [h.Class("space-y-2")],
            [
              h.p([h.Class("deed-kicker text-red")], [`Auction · round ${auction.round}`]),
              h.p(
                [h.Class("display flex flex-wrap items-center gap-2 text-xl text-ink")],
                auction.high === null
                  ? ["No bids yet"]
                  : [`${money(auction.high.amount)} by`, playerTag(h, player(auction.high.seat))],
              ),
              h.p(
                [h.Class("flex flex-wrap items-center gap-1 text-xs text-ink-2")],
                [
                  "Still in:",
                  auction.active.length === 0
                    ? "nobody"
                    : playerTags(h, auction.active.map(player)),
                  `· sealed bids, everyone bids at once; opening bid ≥ $${state.config.rules.auctionMinOpening}.`,
                ],
              ),
              bidsTable(auction.id),
            ],
          ),
        ],
      ),
    ),
    Match.tag("BuildingAuction", (auction) =>
      h.div(
        [h.Class("mb-4 space-y-2 rounded-md border-[1.5px] border-red/50 bg-red/5 p-3")],
        [
          h.p(
            [h.Class("deed-kicker text-red")],
            [`Building shortage · ${auction.unitsLeft} ${auction.kind}(s) left`],
          ),
          h.p(
            [h.Class("flex flex-wrap items-center gap-1.5 text-sm text-ink")],
            auction.high === null
              ? ["No premium bid yet"]
              : [
                  `Premium ${money(auction.high.amount)} by`,
                  playerTag(h, player(auction.high.seat)),
                ],
          ),
          h.p(
            [h.Class("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2")],
            [
              "Requests:",
              ...auction.demand.map((entry) =>
                h.span(
                  [h.Class("inline-flex items-center gap-1")],
                  [playerTag(h, player(entry.seat)), `×${entry.units}`],
                ),
              ),
            ],
          ),
          bidsTable(auction.id),
        ],
      ),
    ),
    Match.orElse(() => h.empty),
  );
};

const tradesView = <M>(
  h: HtmlBuilder<M>,
  players: ReadonlyArray<SeatPlayer>,
  events: ReadonlyArray<GameEvent>,
  onTurn: (turn: number) => M | null,
): Html => {
  const trades = events
    .filter((event): event is EventOf<"TradeExecuted"> =>
      Predicate.isTagged(event, "TradeExecuted"),
    )
    .slice(-8)
    .reverse();

  if (trades.length === 0) return h.p([h.Class("text-xs text-muted")], ["No trades yet."]);

  return h.ul(
    [h.Class("space-y-2")],
    trades.map((trade) => {
      const jump = onTurn(trade.turn);

      return h.keyed("li")(
        `trade-${trade.offerId}-${trade.seq}`,
        [h.Class("rounded-md border border-line bg-paper-2 p-2 text-xs")],
        [
          h.div(
            [h.Class("mb-1 flex items-center gap-1.5")],
            [
              seatToken(h, seatPlayer(players, trade.from), "sm"),
              h.span([h.Class("text-muted")], ["⇄"]),
              seatToken(h, seatPlayer(players, trade.to), "sm"),
              jump === null
                ? h.span([h.Class("num ml-auto text-muted")], [`turn ${trade.turn}`])
                : h.button(
                    [
                      h.Type("button"),
                      h.Class("num ml-auto text-muted underline decoration-dotted hover:text-red"),
                      h.OnClick(jump),
                    ],
                    [`turn ${trade.turn}`],
                  ),
            ],
          ),
          h.div(
            [h.Class("grid items-center gap-1 sm:grid-cols-[auto_1fr]")],
            [
              sideLabel(h, seatPlayer(players, trade.from), "gave"),
              assetsView(h, trade.give),
              sideLabel(h, seatPlayer(players, trade.to), "gave"),
              assetsView(h, trade.get),
            ],
          ),
        ],
      );
    }),
  );
};

export const tableView = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  appliedEvents: ReadonlyArray<GameEvent>,
  onTurn: (turn: number) => M | null,
): Html => {
  const threads = [...new Set(state.offers.map((offer) => offer.thread))];

  return h.div(
    [h.Class("space-y-4")],
    [
      auctionPanel(h, state, appliedEvents),
      h.section(
        [],
        [
          h.h3([h.Class("deed-kicker mb-2 text-ink-2")], ["Negotiation this session"]),
          threads.length === 0
            ? emptyView(
                h,
                "No offers on the table",
                "Offers, counter-offers and their comments appear here while a table or debt session is open.",
              )
            : h.div(
                [h.Class("space-y-3")],
                threads.map((thread) =>
                  h.keyed("div")(
                    `thread-${thread}`,
                    [h.Class("rounded-md border border-dashed border-line p-2")],
                    [
                      h.p(
                        [
                          h.Class(
                            "mb-1.5 text-[10px] font-bold tracking-widest text-muted uppercase",
                          ),
                        ],
                        [`Thread #${thread}`],
                      ),
                      h.ul(
                        [h.Class("space-y-2")],
                        state.offers
                          .filter((offer) => offer.thread === thread)
                          .map((offer) => offerCard(h, offer, state.players)),
                      ),
                    ],
                  ),
                ),
              ),
        ],
      ),
      h.section(
        [],
        [
          h.h3([h.Class("deed-kicker mb-2 text-ink-2")], ["Trades so far"]),
          tradesView(h, state.players, appliedEvents, onTurn),
        ],
      ),
    ],
  );
};
