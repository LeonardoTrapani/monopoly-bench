# monopoly-bench — specification

A benchmark where LLMs play classic Monopoly against each other under the official
rules, with negotiation, auctions, jail, cards and bankruptcy. Every game is
observable live and replayable; every model gets the same tools and the same prompt.

This document is the single source of truth for the first implementation. Where the
code and this document disagree, fix one of them in the same change.

---

## 1. Goals and non-goals

**Goals**

- Official Monopoly rules (Hasbro C1009, 2021 rulebook, US board) with a short,
  explicit list of declared variants (§3.3).
- A pure, deterministic rules engine: same seed + same player actions ⇒ same game.
- LLM players built on Pi (`@earendil-works/pi-agent-core` + `pi-ai`, OpenRouter
  underneath), all with identical tools and system prompt.
- "Any time" actions of the real game (building, mortgaging, trading, outbidding)
  modelled with simultaneous rounds and selective wake-ups instead of real time.
- Runs of many games with seat rotation, per-format ratings (2–6 players), and rich
  statistics in a SQL database.
- A public, Monopoly-branded web app: leaderboard, live games, replays, model pages,
  and a form to start runs (API key required).
- Everything deployable to Cloudflare with Alchemy.

**Non-goals (for now)**

- Real-time play (live clock). The game is paused while players think.
- Free table chat. Text exists only attached to trade offers (§5.6).
- Human players.
- Multi-party (3+) trades in a single offer.

---

## 2. Stack and repository layout

| Concern         | Choice                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------- |
| Language        | TypeScript (strict), ESM                                                                     |
| Package manager | Bun workspaces (`packageManager: bun@1.4.2`)                                                 |
| Toolchain       | Vite+ (`vp check`, `vp test`, `vp build`, `vp run`)                                          |
| Lint            | Oxlint through Vite+, type-aware, plus vendored anti-slop rules (`tools/oxlint/anti-slop`)   |
| Core library    | Effect **4.0.0** pinned everywhere (Foldkit requires exactly 4.0.0)                          |
| Frontend        | Foldkit (Elm architecture on Effect), Tailwind, served as Worker static assets               |
| Agents          | `@earendil-works/pi-agent-core`, `pi-ai` (OpenRouter); sessions persisted in PlayerDO SQLite |
| Infra           | Cloudflare Workers, Durable Objects, D1, R2 — defined with Alchemy v2                        |

```
packages/
  engine/   pure rules engine: data, schemas, decide/evolve, views, valuation, wake rules
  bots/     scripted policies (random, heuristic) used for tests, simulations, baselines
  agent/    Pi harness: system prompt, wake message rendering, tools, turn runner, usage
  sim/      in-process game host (bots and/or LLM seats) used by tests and the CLI
apps/
  worker/   Alchemy stack + Worker API + GameDO + PlayerDO + RunDO + D1 + R2
  web/      Foldkit web app
  cli/      `mb` CLI: local simulations, remote run creation/status
tools/oxlint/anti-slop/   vendored lint rules (see PROVENANCE.md)
```

Commands from the repo root: `bun install`, `bunx vp check`, `bunx vp test`,
`bun run sim -- --players 4 --seed 1` (local bot game), `bun --cwd apps/worker dev`
(Alchemy local dev), `bun --cwd apps/worker deploy`.

---

## 3. Rules

### 3.1 Source

The Hasbro C1009 rulebook (2021, `instructions.hasbro.com`), US Standard Edition board
and title deeds, US Chance deck (2008+), US Community Chest deck (October 2021). Exact
data lives in `packages/engine/src/data/` (board, title deeds, cards) and is the
authority for numbers.

Key rules, all implemented as written:

- 2–6 players, $1,500 each, everyone starts on GO; seat order is the turn order
  (the run decides seats, see §8). GO salary $200 when passing or landing.
- Doubles: roll again; third consecutive doubles → go directly to jail, turn ends.
- Unowned property: buy at list price or it is auctioned. Auction: anyone may bid,
  including the player who declined; opening bid at least $10, raises at least $1;
  the auction ends when nobody raises; if nobody bids the deed stays with the bank.
- Rent: streets per title deed; double rent on unimproved streets of a complete color
  set (also when another street of the set is mortgaged, the unmortgaged ones still
  double); railroads 25/50/100/200; utilities 4×/10× dice. No rent on mortgaged
  property.
- Building: only with a complete color set and no mortgaged street in it; build
  evenly; max 4 houses then a hotel (returning 4 houses); 32 houses, 12 hotels.
  If several players want the last houses/hotels, they are auctioned (start $10,
  +$1). With no buildings left, nobody can buy until some are sold back.
- Selling buildings: half price, evenly. Selling a hotel returns it and gives back 4
  houses; if the bank lacks 4 houses, the property drops to as many houses as the
  bank can supply and the remaining value is paid at half price as well; sibling
  streets are reduced automatically to keep even building.
- Mortgage: only with no buildings on the whole color set; receive the mortgage value;
  unmortgage for mortgage value + 10% (rounded up to the dollar).
- Trades: property (no buildings in the color set), cash and Get Out of Jail Free
  cards, any agreed amounts. No loans, no rent-immunity deals. Receiving a mortgaged
  property: pay 10% now (keep mortgage) or unmortgage now (110%).
- Jail: entering via Go To Jail space, card, or 3 doubles; never collects GO. At the
  start of each jailed turn: pay $50 then roll and move, use a card then roll and
  move, or roll for doubles (doubles → move with that roll, no extra roll). After the
  third failed attempt: pay $50 and move with that roll. Jailed players still collect
  rent, bid, build, mortgage and trade.
- Cards: draw top, apply immediately, put at the bottom; Get Out of Jail Free is kept
  until used (then bottom of its deck) and may be traded. "Nearest railroad" pays
  twice the rent; "nearest utility" pays 10× a fresh dice roll. Go Back 3 Spaces can
  land on Community Chest (draw again).
- Debt: when a player owes more cash than they have, they must raise money (sell
  buildings, mortgage, sell property/cards to other players). If they cannot, they
  are bankrupt:
  - to a player: buildings are sold to the bank at half price first (cash to the
    creditor), then all property, cash and jail cards go to the creditor; for each
    mortgaged property received the creditor immediately pays 10% or unmortgages.
  - to the bank: mortgages are cancelled, all property goes back to the bank and is
    immediately auctioned one deed at a time (board order); jail cards go to the
    bottom of their decks.
- The game ends when one player remains (or at the turn cap, §3.3).

### 3.2 Data checklist

`data/board.ts`: 40 spaces with kind (`go`, `street`, `railroad`, `utility`, `tax`,
`chance`, `communityChest`, `jail`, `freeParking`, `goToJail`), name, color group,
price, rents `[base, 1h, 2h, 3h, 4h, hotel]`, house cost, mortgage value.
Income Tax $200, Luxury Tax $100.

`data/cards.ts`: Chance (16): Advance to Boardwalk; Advance to Go; Advance to Illinois
Avenue; Advance to St. Charles Place; Advance to the nearest Railroad ×2; Advance to
the nearest Utility; Bank pays dividend $50; Get Out of Jail Free; Go Back 3 Spaces;
Go to Jail; General repairs $25/house $100/hotel; Speeding fine $15; Take a trip to
Reading Railroad; Elected Chairman of the Board, pay each player $50; Building loan
matures, collect $150. Community Chest (16, 2021 texts, same effects as 2008):
Advance to Go; collect $200; pay $50 (bake sale); collect $50; Get Out of Jail Free;
Go to Jail; collect $10 from each player (street party); collect $20; collect $100 ×3;
pay $100 (car wash); pay $50 (animal shelter); $40/house $115/hotel; collect $25;
collect $10. Use the 2021 flavour texts verbatim in the data file.

### 3.3 Declared variants

These are the only intentional differences from C1009. They are shown on the
methodology page.

1. **Rent is automatic.** The rulebook makes the owner ask before the next roll.
2. **Turn cap.** C1009 has no time limit. A game also ends after `maxRounds` full
   rounds; players are then ranked by net worth: cash + printed price of unmortgaged
   property + half price (mortgage value) of mortgaged property + buildings at
   purchase price (a hotel = 5 × house cost). This is the valuation of the classic
   rules' time-limit game. Ties broken by cash, then seat order.
3. **"Any time" happens at defined points**: the open table before rolls (§5), inside
   debt resolution and inside negotiations. Nothing can be done during an auction or
   between a roll and the end of its resolution.
4. **Two-party offers.** Many offers may compete in a negotiation, but each offer has
   exactly two parties.
5. **Simultaneity instead of speed.** Actions in the same round are hidden from each
   other and applied in a fixed order (§5.4).

---

## 4. Engine (`packages/engine`)

Pure TypeScript + Effect `Schema`. No I/O, no clocks, no `Math.random`.

### 4.1 Decider pattern

```ts
newGame(config: GameConfig): { state: GameState; events: ReadonlyArray<GameEvent> }
decide(state, command: Command): Result<ReadonlyArray<GameEvent>, IllegalCommand>
evolve(state, event: GameEvent): GameState
apply(state, command): Result<{ state; events }, IllegalCommand>   // decide + fold evolve
pending(state): Pending                                             // who must act now
playerView(state, seat): PlayerView                                 // what one player may see
spectatorView(state): SpectatorView                                 // everything public + private for the viewer
replay(config, events): GameState                                   // fold from newGame
```

- `decide` emits every consequence of a command, including all automatic steps that
  follow (closing a round, rolling dice, moving, paying rent, drawing cards, opening the
  next decision), until the game needs player input again or ends.
- `evolve` never fails and never draws randomness: events carry all outcomes (dice
  values, card drawn, auction winner).
- Randomness is counter-based: `rng(seed, n)` (e.g. splitmix/xoshiro seeded from
  `hash(seed, n)`); state keeps the counter, events that consumed randomness carry
  the values and the new counter. Initial deck order derives from the seed.
- Invariants checked in tests after every event: total houses on board + bank = 32,
  hotels likewise, each property has at most one owner, no negative cash outside an
  open debt, even building, no buildings on mortgaged sets, decks are permutations.

### 4.2 Control state

`GameState.control` is the turn plus a **stack of frames**; the top frame decides who
must act. Frames:

| Frame                           | Actors                                      | Ends when                                          |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| `Table` (session)               | everyone (round 1), then selective wake-ups | a round wakes nobody, or `maxTableRounds`          |
| `JailChoice`                    | jailed active player                        | they pick pay / card / roll                        |
| `BuyChoice`                     | active player                               | buy or decline (may mortgage/sell buildings first) |
| `Auction`                       | bidders still in and not leading            | a round with no raise                              |
| `BuildingAuction`               | players who asked for scarce buildings      | a round with no raise                              |
| `Debt` → `RaiseFunds` (session) | debtor; others only via wake rules          | debt paid, or bankruptcy                           |
| `MortgagedTransfer`             | receiver of mortgaged deeds                 | each deed: keep (10%) or unmortgage                |

Engine-only steps (dice, movement, rent, taxes, card effects, bankruptcy transfers) run
inside `decide` without frames that wait for input. Multi-creditor cards (pay each
player, collect from each player) create one `Debt` per pair, in turn order.

In the implementation one `RaiseFunds` frame carries the debt (debtor, creditor,
amount, reason). Engine work that must wait behind an interactive frame (the remaining
payments of a card, the auctions after a bankruptcy, a move after the forced jail fine)
is stored in that frame's `after` list of tasks and runs when the frame closes.

### 4.3 Rounds, drafts and fixed order

Session frames (`Table`, `RaiseFunds`), auctions and building auctions run in
**rounds**:

1. The engine computes the set of seats to wake for round _k_ (§5.3) and emits
   `RoundOpened{ round, awaiting, reasons }`.
2. Each awaited seat submits commands. In sessions, management and trade commands are
   validated immediately against the round snapshot **plus that seat's own drafts**,
   then stored as drafts (private to the seat until the round closes). The seat ends
   its round with `Done`.
3. When every awaited seat is done (or timed out, see `TimeoutSeat`), the engine
   closes the round: drafts are applied in **fixed order** starting from the active
   player and continuing in turn order; each draft is re-validated at application
   time and dropped with an `ActionDropped{ reason }` event if it no longer holds.
4. Building contention: if, at close, total requested houses (or hotels) exceed the
   bank supply and more than one seat requested them, the scarce units are auctioned
   (`BuildingAuction`) one at a time among the requesters; winners place them by
   their draft order.

Single-actor frames (`JailChoice`, `BuyChoice`, `MortgagedTransfer`) apply commands
immediately.

### 4.4 Commands

Every command carries `seat` and `decisionId` (the id of the pending request it
answers; stale ids are rejected).

| Command                                                                   | Where                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Build{ property }` (one house, or hotel on 4 houses)                     | Table, BuyChoice                                             |
| `SellBuilding{ property }` (one level)                                    | Table, BuyChoice, RaiseFunds                                 |
| `Mortgage{ property }`, `Unmortgage{ property }`                          | Table, BuyChoice (mortgage only), RaiseFunds (mortgage only) |
| `Offer{ to?, give, get, comment?, replyTo? }`                             | Table, RaiseFunds                                            |
| `Accept{ offerId }`, `Reject{ offerId, comment? }`, `Withdraw{ offerId }` | Table, RaiseFunds                                            |
| `Message{ offerId, text }` (comment in a thread, no new terms)            | Table, RaiseFunds                                            |
| `Follow{ group }`, `Unfollow{ group }`                                    | any session                                                  |
| `Done`                                                                    | sessions                                                     |
| `PayJailFine`, `UseJailCard`, `RollForDoubles`                            | JailChoice                                                   |
| `Buy`, `Decline`                                                          | BuyChoice                                                    |
| `Bid{ amount }`, `PassBid`                                                | Auction, BuildingAuction                                     |
| `KeepMortgage{ property }`, `PayOffMortgage{ property }`                  | MortgagedTransfer                                            |
| `DeclareBankruptcy`                                                       | RaiseFunds (debtor only)                                     |
| `TimeoutSeat{ seat, decisionId }`                                         | host only: applies the default action (§6.5)                 |
| `AbortGame{ reason }`                                                     | host only                                                    |

`give`/`get` = `{ cash, properties[], jailCards }`. `to` omitted = open offer: any
other seat may accept it.

Implementation notes: decision ids are `<frameId>.<round>.<seat>` (unique per frame,
round and seat; single-actor frames have round 1). `AbortGame` is the only command
without `seat`/`decisionId`. `DeclareBankruptcy` is legal only when the debtor's
liquidation value (after its own drafts) is below the debt: a debtor who can still pay
from the bank must raise the money (its `Done` liquidates automatically, §5.2).

### 4.5 Events

Every event has `seq`, `turn`, and `visibility`: `public`, or `{ seats: Seat[] }`.
Drafts and follows are private to their seat; offers, comments and outcomes are
public. Spectators see everything. The full list is the `GameEvent` union in
`packages/engine/src/schema/events.ts`; the viewer must be able to rebuild every
screen from events alone.

`DecksShuffled` (initial deck order) is visible to spectators only (`{ seats: [] }`).
Control changes are explicit events (`FramePushed`, `FramePopped`, `RoundOpened`,
`RoundClosed`, ...), so `evolve` stays a plain fold. A `BuildingSold` carries every level
change of one sale (a hotel sold during a house shortage also lowers its siblings) so
that every intermediate state builds evenly; on bankruptcy the asset events come
before `PlayerBankrupt` for the same reason.

### 4.6 Views

`playerView(state, seat)` returns the board, all players' public state (cash, position,
deeds, buildings, mortgages, jail status, jail cards count), bank supply, the current
frame and round, open offers, the seat's own follows and drafts, and the legal command
kinds for that seat. It never includes deck order or other seats' drafts.

`digest(events, sinceSeq, seat)` renders short English lines ("B rolled 5+3 and landed
on Tennessee Avenue", "Auction: B won Tennessee Avenue for $200") for the wake message.

---

## 5. Turn flow

### 5.1 Order of a turn

1. **Open table** (session, rounds) — skipped per `tableFrequency`.
2. **Jail choice** — only if the active player is in jail.
3. **Roll and move** — engine; table closed until resolution ends.
4. **Resolution** — rent/tax/card/jail automatically; unowned property → `BuyChoice`
   → `Auction` on decline; debts → `Debt`/`RaiseFunds`.
5. **End** — doubles: same player again from step 1 (table only if
   `tableFrequency = everyRoll`); otherwise next player.

### 5.2 What each session allows

- **Table**: everyone not bankrupt, including jailed players: `Build`, `SellBuilding`,
  `Mortgage`, `Unmortgage`, `Offer`, `Accept`, `Reject`, `Withdraw`, `Message`,
  `Follow`, `Unfollow`, `Done`.
- **RaiseFunds**: the debtor: `SellBuilding`, `Mortgage`, `Offer`, `Accept`, `Reject`,
  `Withdraw`, `Message`, `DeclareBankruptcy`, `Done`. Others, when woken: `Offer`,
  `Accept`, `Reject`, `Withdraw`, `Message`, `Done`. After each round the engine pays
  the debt automatically if the debtor's cash covers it. `Done` by the debtor with the
  debt unpaid and nothing left to sell or mortgage ⇒ bankruptcy; with assets left ⇒
  the engine liquidates automatically (§6.5) and declares bankruptcy only if still short.
  Since every round ends with `Done`, the debtor counts as finished when a round closes
  in which it used no trade command and nothing new is addressed to it (so it can wait
  one round for an answer to its own offer); `maxTableRounds` also bounds this session.
  A debtor who owns no deed and no jail card is bankrupt at once, without a session.

### 5.3 Wake rules

Round 1 of a table wakes every active seat. Round 1 of `RaiseFunds` wakes the debtor.
From round 2 on, a seat is woken only if, during the previous round:

- **addressed** — an offer, counter-offer, reject or message was addressed to it;
- **in thread** — a new offer was posted in a thread it participates in
  (threads link offers through `replyTo`; participants are the parties of any offer
  in the thread);
- **follows** — a new offer involves a property in a color group it follows
  (default follows: every group where it owns a deed; railroads and utilities are
  groups too);
- **open call** — a new open offer (no `to`) was posted: every seat is woken once;
- **debtor** — in `RaiseFunds`, the debtor is woken every round while the debt is open.

Auctions wake all eligible bidders in round 1, then every bidder still in who is not
the current leader. A session ends when the next round would wake nobody, or after
`maxTableRounds` rounds; all open offers expire when their session ends.

### 5.4 Offers

- An offer can be accepted from the round after it was posted; acceptances are executed
  at round close in fixed order and re-validated (ownership, no buildings in the color
  set, cash on hand, jail cards). An acceptance that fails validation, or loses to an
  earlier acceptance on the same assets, is dropped with `OfferInvalidated`.
- A counter-offer is a new `Offer` with `replyTo`.
- Limits per seat per round: `maxOffersPerRound` new offers and `maxMessagesPerRound`
  messages; `commentMaxChars` per comment.
- Receiving mortgaged deeds pushes a `MortgagedTransfer` frame for the receiver after
  the round closes.
- A trade must leave each side able to pay the 10% interest on the mortgaged deeds it
  receives, so trades never open debts. A failed acceptance closes the offer when the
  proposer's side no longer holds; when only the acceptor's side fails, the offer stays
  open.
- Open offers: a `Reject` from a seat other than the proposer records the refusal and
  wakes the proposer, but the offer stays open for the others. An open offer may ask
  only for deeds of a single other owner (only that owner can accept it).

### 5.5 Auctions

Round 1 wakes every eligible bidder (not bankrupt) at the same time with the current
high bid (none). Each submits `Bid{ amount }` (≥ $10 opening, ≥ high + $1 later) or
`PassBid` (out for this auction). Highest bid in a round leads; ties are broken by fixed
order. A bid must not exceed the bidder's liquidation value (cash + mortgage values +
half building value); a winner short of cash enters `Debt` to the bank. Seats whose
liquidation value is below the opening bid are not woken.

**Building auctions** (§4.3 step 4) use the same rounds, one scarce unit at a time,
among the requesters whose requests are not yet covered. The bid is a **premium** paid
to the bank on top of the normal building cost (deviation: with a total-price bid a
$200 house could be won for $10), limited to the bidder's cash minus its cheapest
requested building. Once supply covers the remaining requests, or only one requester
is left, units are granted without bidding; a unit nobody bids on ends the building
auction and the remaining units are not sold this round.

### 5.6 Text

Text exists only as `comment` on offers/rejects and `Message` in a thread, max
`commentMaxChars`. It is public and never binding. The system prompt reminds models of
the official rule: no loans and no rent-immunity deals; only the offer terms are
enforced.

---

## 6. Agents (`packages/agent`)

### 6.1 Identity and prompt

Players see who they play against: seat letter and model label (identities visible).
The system prompt (same for everyone): role, rules summary (§3), declared variants,
how rounds and wake-ups work, tool usage, and the objective (finish first; at the turn
cap, highest net worth). English.

### 6.2 Wake message

Built only from data (no randomness):

1. what happened since the seat's last wake (`digest` from its cursor),
2. the seat's `playerView` rendered compactly,
3. the question (frame, round, why it was woken) and the legal command kinds,
4. open offers and threads with comments,
5. the seat's notes.

Context resets at every new decision; inside one session the rounds of that session
continue the same conversation (Pi follow-up messages). Notes are the only memory
across decisions.

### 6.3 Tools

Same names and descriptions for every model, always all available; illegal calls
return an error with the engine's reason and count as invalid actions.

`inspect`, `note`, `follow`, `unfollow`, `build`, `sell_building`, `mortgage`,
`unmortgage`, `offer`, `accept`, `reject`, `withdraw`, `message`, `buy`, `decline`,
`pay_jail_fine`, `use_jail_card`, `roll_for_doubles`, `bid`, `pass_bid`,
`keep_mortgage`, `pay_off_mortgage`, `declare_bankruptcy`, `done`.

Tools that answer the question end the wake (`terminate: true`): `done`, `buy`,
`decline`, `pay_jail_fine`, `use_jail_card`, `roll_for_doubles`, `bid`, `pass_bid`,
`declare_bankruptcy`, and `keep_mortgage`/`pay_off_mortgage` when no mortgaged deed is
left to decide. Parameter schemas are derived from the engine's Effect schemas.

### 6.4 Limits per wake

`maxToolCallsPerWake` (default 24), `maxInvalidPerWake` (6), `wakeTimeoutMs`
(180 000). Usage (input/output/reasoning tokens, cost, latency) is recorded per wake.
A model that stops without calling an answering tool is asked again in the same
conversation; each such stop counts as an invalid action. Calls after the answer, or
over the call limit, are refused without counting as invalid.

### 6.5 Defaults on timeout or failure

Applied by the engine via `TimeoutSeat`: session → `Done`; `BuyChoice` → `Decline`;
auctions → `PassBid`; `JailChoice` → `RollForDoubles` (forced payment on the third
attempt is the rule); `MortgagedTransfer` → `KeepMortgage`; `RaiseFunds` debtor →
automatic liquidation (sell buildings evenly from the most expensive set, then mortgage
deeds from the cheapest), then pay or bankruptcy. Each default is recorded.

### 6.6 Seat kinds

- `llm`: `{ model: <OpenRouter id>, label, reasoning?: "off" | "low" | "medium" | "high", maxOutputTokens? }`
- `bot`: `{ policy: "random" | "heuristic" }` — runs in-process, no LLM. Bots appear on
  the leaderboard as baselines.

---

## 7. Runtime (`apps/worker`)

### 7.1 Durable Objects

- **GameDO** (one per game): the only writer of game state. Holds `GameState`
  snapshot + event log in its SQLite storage (written in one transaction per
  command/round close), per-seat cursors, deadlines (alarm). Wakes seats, applies
  commands through the engine, broadcasts events to spectators over hibernatable
  WebSockets, writes summaries to D1 at turn end, archives to R2 at the end, then
  notifies its RunDO.
- **PlayerDO** (one per LLM seat per game): runs the Pi agent for a wake
  (`pi-agent-core` directly, the same loop as local simulations; the session's messages
  are persisted in the object's SQLite; alarm-driven so no request stays open while the
  model thinks). Tools call GameDO RPC (`submit`, `done`, `inspect`). Every RPC carries
  `(gameId, seat, decisionId, callId)`; duplicates are ignored (idempotency). A wake cut
  off by an eviction is not re-run: it is reported and GameDO applies the default.
  `pi-durable` was evaluated and not used (reasons in `apps/worker/README.md`).
- **RunDO** (one per run): queue of games, concurrency limit, budget accounting,
  ratings update when a game finishes (a version-guarded D1 batch, since several runs
  may finish games at once).
- Bot seats run inside GameDO.

### 7.2 API

Public (read-only, CORS open):

- `GET /api/leaderboard?players=4`
- `GET /api/models`, `GET /api/models/:id`
- `GET /api/runs`, `GET /api/runs/:id`
- `GET /api/games?status=live|finished&players=&model=`, `GET /api/games/:id`
- `GET /api/games/:id/events?since=` (NDJSON, one event per line with `seq > since`;
  live from GameDO, finished from R2)
- `GET /api/games/:id/transcripts?seat=` (NDJSON `WakeTranscript`s; live from GameDO,
  finished from R2 `seats/<seat>.jsonl`)
- `GET /api/games/:id/ws` (spectator WebSocket: server → client only; messages `Hello`,
  `Events`, `Activity`, `Status`, see `apps/worker/README.md`)

Protected (`Authorization: Bearer <BENCH_API_KEY>`):

- `POST /api/runs` — create and start a run (body = `RunConfig`)
- `POST /api/runs/:id/cancel` — returns `{ run: RunSummary }`

Secrets (Alchemy, from env): `BENCH_API_KEY`, `OPENROUTER_API_KEY`.

### 7.3 Storage

**D1** (via `@effect/sql-d1`), tables: `runs`, `games`, `seats`, `wakes`, `offers`,
`auctions`, `ratings`, `rating_history`, plus `rating_tables`/`rating_guard` for the
optimistic concurrency of rating updates. One row per wake (`wakes`) holds kind, round,
reasons, latency, tokens, cost, tool calls, invalid actions, timeout; per-seat usage is
aggregated from it when read.

**R2**: `games/<gameId>/events.jsonl`, `games/<gameId>/summary.json`,
`games/<gameId>/seats/<seat>.jsonl` (full transcript with reasoning and notes).

---

## 8. Runs and ratings

```ts
RunConfig {
  name?: string
  players: SeatSpec[]            // 2..6 seats (llm or bot)
  seeds: number                  // number of seeds; games = seeds × players (cyclic seat rotation)
  maxRounds?: number             // turn cap override
  tableFrequency?: "everyRoll" | "everyTurn" | "everyRound" | "off"
  concurrency?: number           // games at once (default 2)
  budgetUsd: number              // hard cap: no new wakes after it is reached; games abort
}
```

All rotations of one seed share the game seed (same dice and decks, competitors moved
one seat along); seed `s` derives from `s` alone, so it is the same in every run. The
budget gates LLM wakes only: games without LLM seats cost nothing and still run when
the budget is spent.

Ratings: OpenSkill (Plackett–Luce), one table per player count, ranks from final
standings. Leaderboard score = `mu − 3σ`. A competitor holding several seats of one
game is rated per seat from the same prior and gets the mean of the posteriors. Also shown: games, wins, average place,
average net worth, invalid-action rate, timeout rate, cost per game, latency per wake.

---

## 9. Web app (`apps/web`, Foldkit)

Monopoly-branded (red wordmark banner, board-green surfaces, property colors, deed-card
styling) and inspired by the big benchmark sites (LMArena-style leaderboard table,
Artificial-Analysis-style "rating vs cost" scatter, Kaggle-Game-Arena-style game viewer).
No Hasbro artwork: the board is drawn in SVG by us.

Routes:

- `/` — hero, **live games strip** (if any), leaderboard for the selected player count,
  rating-vs-cost scatter, head-to-head matrix, call to action "Start a run".
- `/games` — live and finished games, filters.
- `/games/:id` — board, players, phase/round with who is thinking, offers and threads,
  reasoning and tool calls per wake, timeline scrubber, net worth chart. Live games
  stream over WebSocket; finished games load `events.jsonl`. Both rebuild state with
  the same engine (`replay`) in the browser.
- `/models/:id` — rating, stats, behavior (trades proposed/accepted, auction premium vs
  list price, bankruptcies), recent games.
- `/runs`, `/runs/:id`, `/runs/new` — run list, progress, and the start form (API key
  kept in localStorage, sent as Bearer).
- `/about` — methodology: rules, variants, protocol, metrics.

---

## 10. CLI (`apps/cli`)

- `mb sim [--players N] [--seed S] [--bots random,heuristic,...] [--max-rounds R] [--table-frequency F] [--game-id ID] [--out DIR] [--no-out] [--verify] [--llm <openrouter id>...]`
  — run a game in-process and print the standings; writes `out/<gameId>.events.jsonl`
  (one encoded event per line) and `out/<gameId>.config.json`. `--llm` is not
  implemented yet (bots only).
- `mb calibrate [--games N] [--players 2,3,4,5,6] [--bot heuristic] [--cap R]` — natural
  game length distribution of bot games, used for `maxRounds` (§12).
- `mb run create <config.json>` / `mb run status <id>` — remote, uses `BENCH_API_KEY`
  and `BENCH_URL`.

---

## 11. Testing

- Engine unit tests per rule (rent table, doubles, jail exits, cards, building/selling
  evenness, shortage auction, mortgages, trades, debt, both bankruptcy paths, turn cap
  valuation).
- Property tests: thousands of bot games (random + heuristic) across 2–6 players and
  seeds; invariants after every event; `replay(config, events)` equals the live state;
  every game terminates.
- Agent harness tests with a scripted fake model (no network).
- Worker tests with a local Alchemy/workerd run of a bot-only game end to end.
- One real low-budget LLM game before release.

---

## 12. Defaults

| Setting                                     | Default                     |
| ------------------------------------------- | --------------------------- |
| `startingCash` / `goSalary` / `jailFine`    | 1500 / 200 / 50             |
| `houses` / `hotels`                         | 32 / 12                     |
| `auctionMinOpening` / `auctionMinRaise`     | 10 / 1                      |
| `tableFrequency`                            | `everyTurn`                 |
| `maxTableRounds`                            | 6                           |
| `maxOffersPerRound` / `maxMessagesPerRound` | 2 / 2                       |
| `commentMaxChars` / `notesMaxChars`         | 280 / 2000                  |
| `maxRounds`                                 | 120 (calibrated, see below) |
| `maxToolCallsPerWake` / `maxInvalidPerWake` | 24 / 6                      |
| `wakeTimeoutMs`                             | 180 000                     |
| run `concurrency`                           | 2                           |

**`maxRounds` calibration.** `bun apps/cli/src/main.ts calibrate --games 200 --cap 400
--seed cal`: 200 all-heuristic games per player count, default rules, natural length in
full rounds (every game ended by bankruptcies before the 400-round cap):

| Players | p50 | p90 | p95 | p99 | max | ≤ 100 | ≤ 150 |
| ------- | --- | --- | --- | --- | --- | ----- | ----- |
| 2       | 73  | 105 | 116 | 140 | 283 | 88.0% | 99.5% |
| 3       | 58  | 86  | 105 | 132 | 212 | 94.0% | 99.0% |
| 4       | 55  | 91  | 100 | 133 | 157 | 95.0% | 99.5% |
| 5       | 48  | 75  | 94  | 137 | 183 | 96.0% | 99.5% |
| 6       | 44  | 71  | 86  | 129 | 192 | 98.0% | 99.5% |

120 rounds is above the 95th percentile for every player count (the largest is 116,
with 2 players), so about 95% or more of heuristic games end naturally.
