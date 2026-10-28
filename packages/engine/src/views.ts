/** Player and spectator views (SPEC §4.6). */
import { effectiveFollows, topFrame } from "./access.ts";
import { pending, requestOf } from "./pending.ts";
import { netWorth } from "./rules.ts";
import { standings } from "./standings.ts";

import type { Seat } from "./schema/common.ts";
import type { GameState } from "./schema/state.ts";
import type { PlayerView, PublicPlayer, SpectatorView } from "./schema/views.ts";

const publicPlayers = (state: GameState): ReadonlyArray<PublicPlayer> =>
  state.players.map((current) => ({
    seat: current.seat,
    label: current.label,
    competitorId: current.competitorId,
    cash: current.cash,
    position: current.position,
    inJail: current.inJail,
    jailAttempts: current.jailAttempts,
    jailCards: current.jailCards,
    bankrupt: current.bankrupt,
    bankruptAtTurn: current.bankruptcy?.turn ?? null,
    netWorth: current.bankrupt ? 0 : netWorth(state, current.seat),
  }));

const tableOf = (state: GameState) => ({
  gameId: state.config.gameId,
  status: state.status,
  endReason: state.endReason,
  winner: state.winner,
  rules: state.config.rules,
  turn: state.control.turn,
  gameRound: state.control.gameRound,
  activeSeat: state.control.activeSeat,
  players: publicPlayers(state),
  properties: state.properties,
  bank: state.bank,
  lastDice: state.lastDice,
  frame: topFrame(state) ?? null,
  stack: state.control.stack.map((frame) => frame._tag),
  offers: state.offers,
});

/**
 * What `seat` may see: the board, every player's public state, bank supply, the
 * current frame and round, the session's offers, its own follows and drafts, and its
 * pending request. Never deck order or other seats' drafts.
 */
export const playerView = (state: GameState, seat: Seat): PlayerView => {
  const frame = topFrame(state);

  const drafts = state.drafts.flatMap((draft) =>
    draft.seat === seat && draft.frame === frame?.id ? [draft.command] : [],
  );

  return {
    ...tableOf(state),
    seat,
    follows: effectiveFollows(state, seat),
    drafts,
    request: requestOf(state, seat),
  };
};

/** Everything public and private, for spectators and replays. */
export const spectatorView = (state: GameState): SpectatorView => ({
  ...tableOf(state),
  drafts: state.drafts,
  follows: state.players.map((current) => ({
    seat: current.seat,
    follows: effectiveFollows(state, current.seat),
  })),
  decks: state.decks,
  pending: pending(state),
  standings: standings(state),
});
