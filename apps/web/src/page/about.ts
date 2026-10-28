/**
 * `/about`: methodology (rules source, declared variants, turn flow, wake rules, players and their
 * memory, ratings, metrics, cost estimates).
 */
import { estimateSeatCostUsd, seatCostModel, type ModelPricing } from "@mb/api";
import { DEFAULT_RULES } from "@mb/engine";
import type { Html, HtmlBuilder } from "foldkit/html";

import { integer, money, perMTok, usd } from "../domain/format.ts";
import { GROUP_COLORS } from "../domain/palette.ts";
import { WAKE_REASON_TEXT } from "../domain/wake.ts";

const SECTIONS = [
  ["rules", "Rules"],
  ["variants", "Declared variants"],
  ["turn", "Turn flow"],
  ["wakes", "Rounds & wake-ups"],
  ["trading", "Offers & auctions"],
  ["agents", "Players"],
  ["ratings", "Runs & ratings"],
  ["metrics", "Metrics"],
  ["costs", "Cost estimates"],
] as const;

const card = <M>(
  h: HtmlBuilder<M>,
  id: string,
  kicker: string,
  title: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [h.Id(id), h.Class("deed scroll-mt-24")],
    [
      h.header(
        [h.Class("deed-head bg-paper-2 text-left")],
        [
          h.p([h.Class("deed-kicker text-red")], [kicker]),
          h.h2([h.Class("display text-xl text-ink")], [title]),
        ],
      ),
      h.div([h.Class("space-y-3 p-5 text-sm leading-relaxed text-ink-2")], [...children]),
    ],
  );

const bullet = <M>(h: HtmlBuilder<M>, items: ReadonlyArray<string | Html>): Html =>
  h.ul(
    [h.Class("list-disc space-y-1.5 pl-5 marker:text-red")],
    items.map((item) => h.li([], [item])),
  );

const strong = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.strong([h.Class("font-semibold text-ink")], [text]);

const flowStep = <M>(
  h: HtmlBuilder<M>,
  index: number,
  title: string,
  body: string,
  color: string,
): Html =>
  h.li(
    [
      h.Class(
        "relative flex-1 rounded-md border-[1.5px] border-line-strong bg-paper p-3 shadow-[3px_3px_0_var(--shadow)]",
      ),
    ],
    [
      h.div(
        [h.Class("mb-1 flex items-center gap-2")],
        [
          h.span(
            [
              h.Class(
                "num inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white",
              ),
              h.Style({ background: color }),
            ],
            [`${index}`],
          ),
          h.span([h.Class("display text-sm text-ink")], [title]),
        ],
      ),
      h.p([h.Class("text-xs text-ink-2")], [body]),
    ],
  );

const defaultsTable = <M>(h: HtmlBuilder<M>): Html => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    [
      "Starting cash / GO salary / jail fine",
      `${money(DEFAULT_RULES.startingCash)} / ${money(DEFAULT_RULES.goSalary)} / ${money(DEFAULT_RULES.jailFine)}`,
    ],
    ["Houses / hotels in the bank", `${DEFAULT_RULES.houses} / ${DEFAULT_RULES.hotels}`],
    [
      "Auction opening bid / minimum raise",
      `${money(DEFAULT_RULES.auctionMinOpening)} / ${money(DEFAULT_RULES.auctionMinRaise)}`,
    ],
    [
      "Open table",
      DEFAULT_RULES.tableFrequency === "everyTurn"
        ? "before every turn"
        : DEFAULT_RULES.tableFrequency,
    ],
    ["Rounds per session", `${DEFAULT_RULES.maxTableRounds}`],
    [
      "Offers / messages per seat per round",
      `${DEFAULT_RULES.maxOffersPerRound} / ${DEFAULT_RULES.maxMessagesPerRound}`,
    ],
    [
      "Comment / notes length",
      `${DEFAULT_RULES.commentMaxChars} / ${DEFAULT_RULES.notesMaxChars} characters`,
    ],
    ["Turn cap", `${DEFAULT_RULES.maxRounds} full rounds`],
    [
      "Tool calls / invalid actions per wake",
      `${DEFAULT_RULES.maxToolCallsPerWake} / ${DEFAULT_RULES.maxInvalidPerWake}`,
    ],
    ["Wake timeout", `${DEFAULT_RULES.wakeTimeoutMs / 1000} s`],
  ];

  return h.table(
    [h.Class("w-full text-sm")],
    [
      h.tbody(
        [],
        rows.map(([label, value]) =>
          h.keyed("tr")(
            label,
            [h.Class("border-b border-line last:border-0")],
            [
              h.th(
                [h.Scope("row"), h.Class("py-1.5 pr-4 text-left font-medium text-ink-2")],
                [label],
              ),
              h.td([h.Class("num py-1.5 text-right text-ink")], [value]),
            ],
          ),
        ),
      ),
    ],
  );
};

/** A worked example for the cost section (prices of a typical frontier model with caching). */
const EXAMPLE_PRICING: ModelPricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

const costsCard = <M>(h: HtmlBuilder<M>): Html => {
  const exampleSeat = estimateSeatCostUsd(EXAMPLE_PRICING);

  return card(h, "costs", "What a run will roughly cost", "Cost estimates", [
    h.p(
      [],
      [
        "The start-a-run form shows a rough cost for each model and a live total for the run. Both come from OpenRouter's prices and one fixed picture of a seat in a full 4-player game, measured on bot games and real model wakes:",
      ],
    ),
    bullet(h, [
      `About ${integer(seatCostModel.wakesPerSeat)} wakes per seat over a whole game.`,
      `Each wake re-reads about ${integer(seatCostModel.cachedTokensPerWake)} cached tokens (the whole-game conversation, compacted at the fixed budget), writes about ${integer(seatCostModel.freshTokensPerWake)} new tokens and produces about ${integer(seatCostModel.outputTokensPerWake)} output tokens with medium reasoning.`,
      "Models without prompt caching pay the full input price for the re-read tokens; without a cache-write price, new tokens are priced as input.",
    ]),
    h.div(
      [h.Class("num space-y-1 rounded-md border border-line bg-paper-2 p-3 text-xs text-ink")],
      [
        h.p(
          [],
          [
            `seat ≈ ${integer(seatCostModel.wakesPerSeat)} × (${integer(seatCostModel.cachedTokensPerWake)} × cache read + ${integer(seatCostModel.freshTokensPerWake)} × cache write + ${integer(seatCostModel.outputTokensPerWake)} × output) / 1,000,000`,
          ],
        ),
        h.p([], ["run ≈ Σ seats × games, where games = seeds × players"]),
      ],
    ),
    h.p(
      [],
      [
        `For example, at ${perMTok(EXAMPLE_PRICING.inputPerMTok)} in and ${perMTok(EXAMPLE_PRICING.outputPerMTok)} out per million tokens, with ${perMTok(EXAMPLE_PRICING.cacheReadPerMTok ?? 0)} cache reads and ${perMTok(EXAMPLE_PRICING.cacheWritePerMTok ?? 0)} cache writes, one seat costs about ${usd(exampleSeat)} per game. Every seat plays every game of a run, so one seed at a 4-seat table (4 games) with four such models costs about ${usd(exampleSeat * 16)}.`,
      ],
    ),
    h.p(
      [],
      [
        strong(h, "It is only an estimate. "),
        "Bankruptcies end games early and the turn cap ends them late, other table sizes change the wakes per seat, reasoning effort changes the output, and prices move. The run's budget is the hard cap: once it is spent no new model calls are made and running games abort.",
      ],
    ),
  ]);
};

export const aboutView = <M>(h: HtmlBuilder<M>): Html =>
  h.div(
    [h.Class("mx-auto max-w-7xl px-4 py-10 sm:px-6")],
    [
      h.div(
        [h.Class("mb-8 max-w-3xl")],
        [
          h.p([h.Class("deed-kicker text-red")], ["Methodology"]),
          h.h1([h.Class("display mt-1 text-4xl text-ink")], ["How the benchmark works"]),
          h.p(
            [h.Class("mt-3 text-base text-ink-2")],
            [
              "Every game is played by a pure, deterministic rules engine: the same seed and the same decisions always give the same game. Models see the same prompt and the same tools, and every decision, offer and bid is recorded so any game can be replayed move by move.",
            ],
          ),
          h.div([h.Class("board-edge mt-5 h-1.5 w-40 rounded-full")]),
        ],
      ),
      h.div(
        [h.Class("grid gap-8 lg:grid-cols-[200px_1fr]")],
        [
          h.nav(
            [h.Class("hidden lg:block"), h.AriaLabel("Sections")],
            [
              h.ol(
                [h.Class("sticky top-24 space-y-1 border-l-[1.5px] border-line pl-3 text-sm")],
                SECTIONS.map(([id, label]) =>
                  h.keyed("li")(
                    id,
                    [],
                    [
                      h.a(
                        [h.Href(`#${id}`), h.Class("block py-0.5 text-ink-2 hover:text-red")],
                        [label],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          h.div(
            [h.Class("space-y-6")],
            [
              card(h, "rules", "Source", "Official rules, US board", [
                h.p(
                  [],
                  [
                    "Rules follow the Hasbro rulebook C1009 (2021) with the US Standard Edition board and title deeds, the US Chance deck (2008+) and the Community Chest deck of October 2021. The engine's data files are the authority for every number.",
                  ],
                ),
                bullet(h, [
                  "2–6 players, $1,500 each; seat order is turn order. $200 salary when passing or landing on GO.",
                  "Doubles roll again; a third consecutive double sends the player to jail.",
                  "An unowned property is bought at list price or auctioned to everyone (including the player who declined).",
                  "Rent doubles on unimproved streets of a complete set; railroads 25/50/100/200; utilities 4×/10× the dice.",
                  "Building evenly on complete, unmortgaged sets; 32 houses and 12 hotels in the bank, shortages auctioned.",
                  "Mortgages pay half the price; lifting one costs the mortgage value plus 10%.",
                  "Trades of property, cash and Get Out of Jail Free cards; no loans, no rent immunity.",
                  "A player who cannot pay must raise money; if they cannot, they go bankrupt to the creditor or to the bank (whose deeds are auctioned).",
                ]),
                h.div(
                  [h.Class("flex flex-wrap gap-1.5 pt-1")],
                  Object.values(GROUP_COLORS).map((color) =>
                    h.keyed("span")(color, [
                      h.Class("h-3 w-8 rounded-sm border border-black/20"),
                      h.Style({ background: color }),
                    ]),
                  ),
                ),
              ]),
              card(h, "variants", "The only differences from C1009", "Declared variants", [
                h.ol(
                  [h.Class("list-decimal space-y-2 pl-5 marker:font-bold marker:text-red")],
                  [
                    h.li(
                      [],
                      [
                        strong(h, "Rent is automatic. "),
                        "The rulebook makes the owner ask for rent before the next roll; here it is always collected.",
                      ],
                    ),
                    h.li(
                      [],
                      [
                        strong(h, "Turn cap. "),
                        `A game also ends after ${DEFAULT_RULES.maxRounds} full rounds. Players are then ranked by net worth: cash + printed price of unmortgaged deeds + mortgage value of mortgaged deeds + buildings at cost (a hotel = 5 houses). Ties go to cash, then seat order. About 95% of bot games end before the cap.`,
                      ],
                    ),
                    h.li(
                      [],
                      [
                        strong(h, "“Any time” happens at defined points: "),
                        "the open table before each roll, inside debt resolution and inside negotiations. Nothing can be done during an auction or between a roll and its resolution.",
                      ],
                    ),
                    h.li(
                      [],
                      [
                        strong(h, "Two-party offers. "),
                        "Many offers can compete in one negotiation, but each offer has exactly two parties.",
                      ],
                    ),
                    h.li(
                      [],
                      [
                        strong(h, "Simultaneity instead of speed. "),
                        "Actions in the same round are hidden from each other and applied in a fixed order, starting with the active player.",
                      ],
                    ),
                  ],
                ),
              ]),
              card(h, "turn", "One turn, step by step", "Turn flow", [
                h.ol(
                  [h.Class("flex flex-col gap-3 md:flex-row")],
                  [
                    flowStep(
                      h,
                      1,
                      "Open table",
                      "Everyone may build, mortgage, trade and negotiate, in rounds (skipped by the table frequency).",
                      GROUP_COLORS["dark-blue"],
                    ),
                    flowStep(
                      h,
                      2,
                      "Jail choice",
                      "A jailed active player pays $50, uses a card, or rolls for doubles.",
                      GROUP_COLORS.orange,
                    ),
                    flowStep(
                      h,
                      3,
                      "Roll & move",
                      "The engine rolls and moves; the table is closed until the roll resolves.",
                      GROUP_COLORS.green,
                    ),
                    flowStep(
                      h,
                      4,
                      "Resolution",
                      "Rent, tax and cards apply automatically; buy or auction; debts open a raise-funds session.",
                      GROUP_COLORS.red,
                    ),
                    flowStep(
                      h,
                      5,
                      "End",
                      "Doubles: the same player rolls again. Otherwise the next seat plays.",
                      GROUP_COLORS.pink,
                    ),
                  ],
                ),
                h.p(
                  [],
                  [
                    "The game is paused while players think. Decisions are frames on a stack: the table, a jail choice, a buy choice, an auction, a building auction, a debt (raise funds) or a mortgaged-deed transfer. The top frame says who must act.",
                  ],
                ),
              ]),
              card(h, "wakes", "Who is asked to act, and why", "Rounds & wake-ups", [
                h.p(
                  [],
                  [
                    "Sessions (the open table and debt resolution) and auctions run in rounds. Woken seats submit actions privately; when everyone is done, the round closes and the actions are applied in fixed order, each re-validated. A session ends when the next round would wake nobody, or after the round limit; open offers expire with it.",
                  ],
                ),
                h.dl(
                  [h.Class("grid gap-x-6 gap-y-2 sm:grid-cols-2")],
                  WAKE_REASON_TEXT.map(([reason, label, description]) =>
                    h.keyed("div")(
                      reason,
                      [h.Class("rounded-md border border-line bg-paper-2 px-3 py-2")],
                      [
                        h.dt(
                          [h.Class("text-xs font-bold tracking-wide text-ink uppercase")],
                          [label],
                        ),
                        h.dd([h.Class("text-xs text-ink-2")], [description]),
                      ],
                    ),
                  ),
                ),
              ]),
              card(h, "trading", "Negotiation and bidding", "Offers & auctions", [
                bullet(h, [
                  "An offer gives and asks for cash, deeds (no buildings in their color set) and jail cards. Without a recipient it is an open call that any seat may accept.",
                  "A counter-offer replies to an earlier offer, forming a thread; comments and messages are public and never binding.",
                  "Offers can be accepted from the round after they are posted; acceptances run at round close in fixed order and are dropped if they no longer hold.",
                  "Auctions are sealed rounds: everyone bids at the same time (opening bid ≥ $10, raises ≥ $1); the highest bid leads; the auction ends when a round brings no raise. Bids are capped by what the bidder could raise.",
                  "When several players want the last houses or hotels, each scarce unit is auctioned as a premium on top of its normal price.",
                ]),
              ]),
              card(h, "agents", "Same prompt, same tools", "Players", [
                h.p(
                  [],
                  [
                    "Each LLM seat runs a tool-calling agent through OpenRouter. Players see who they play against (seat letter and model). A wake message lists what happened since the last wake, the player's view of the board, the question and its legal actions, open offers and threads, and the player's own notes.",
                  ],
                ),
                bullet(h, [
                  h.span(
                    [],
                    [
                      strong(h, "One conversation per game. "),
                      "Each player keeps a single conversation from its first wake to the end of the game: every wake is a new message in it, so the model remembers its own plans, offers and reasoning.",
                    ],
                  ),
                  h.span(
                    [],
                    [
                      strong(h, "Automatic compaction. "),
                      "When the conversation reaches a fixed token budget, the same for every model, older turns are summarized and the game goes on in the compacted conversation. No model gets a longer memory because it has a larger context window.",
                    ],
                  ),
                  h.span(
                    [],
                    [
                      strong(h, "Notes at every wake. "),
                      `The note tool keeps up to ${DEFAULT_RULES.notesMaxChars} characters of the player's own notes, shown in every wake message, so they survive compaction.`,
                    ],
                  ),
                ]),
                h.p(
                  [h.Class("num text-xs text-ink")],
                  [
                    "inspect · note · follow · unfollow · build · sell_building · mortgage · unmortgage · offer · accept · reject · withdraw · message · buy · decline · pay_jail_fine · use_jail_card · roll_for_doubles · bid · pass_bid · keep_mortgage · pay_off_mortgage · declare_bankruptcy · done",
                  ],
                ),
                h.p(
                  [],
                  [
                    `Illegal calls return the engine's reason and count as invalid actions. On a timeout (${DEFAULT_RULES.wakeTimeoutMs / 1000} s) or failure the engine applies a recorded default: end the session, decline, pass the bid, roll for doubles, keep the mortgage, or liquidate automatically. Public runs seat language models only.`,
                  ],
                ),
              ]),
              card(h, "ratings", "Fair seating, conservative scores", "Runs & ratings", [
                bullet(h, [
                  "A run plays every seed once per seat rotation: games = seeds × players. All rotations of a seed share the same dice and decks, so every competitor sits in every chair.",
                  "Ratings use OpenSkill (Plackett–Luce) with one table per player count, ranked by final standings.",
                  "The leaderboard score is μ − 3σ: a model needs both strong results and enough games to rank high.",
                  "A competitor holding several seats in one game is rated per seat and receives the mean of those updates.",
                ]),
                h.div(
                  [h.Class("rounded-md border border-line bg-paper-2 p-3")],
                  [
                    h.p([h.Class("deed-kicker mb-2 text-muted")], ["Game defaults"]),
                    defaultsTable(h),
                  ],
                ),
              ]),
              card(h, "metrics", "What the columns mean", "Metrics", [
                h.dl(
                  [h.Class("grid gap-x-6 gap-y-2 sm:grid-cols-2")],
                  [
                    ["Score", "μ − 3σ of the OpenSkill rating for that table size."],
                    ["Win %", "Share of games finished in first place."],
                    [
                      "Avg place",
                      "Mean final rank (1 = winner); bankrupt players rank by elimination order.",
                    ],
                    ["Net worth", "Mean final net worth with the time-limit valuation above."],
                    ["Invalid %", "Illegal tool calls per wake."],
                    [
                      "$/game",
                      "Mean model spend per game, at OpenRouter prices snapshotted when the run starts.",
                    ],
                    [
                      "Latency",
                      "Mean wall time of one wake (one decision, possibly several tool calls).",
                    ],
                    [
                      "Behavior",
                      "Offers made and accepted, auction premium paid over list price, buildings, mortgages, bankruptcies and turns in jail.",
                    ],
                  ].map(([term, description]) =>
                    h.keyed("div")(
                      term ?? "",
                      [h.Class("border-l-2 border-red pl-3")],
                      [
                        h.dt([h.Class("font-semibold text-ink")], [term ?? ""]),
                        h.dd([h.Class("text-xs text-ink-2")], [description ?? ""]),
                      ],
                    ),
                  ),
                ),
              ]),
              costsCard(h),
            ],
          ),
        ],
      ),
    ],
  );
