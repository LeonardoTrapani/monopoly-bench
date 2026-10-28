/** Rankings (SPEC §3.3): survivors by net worth, then cash, then seat order; bankrupt seats after. */
import { netWorth } from "./rules.ts";

import type { GameState } from "./schema/state.ts";
import type { Standing } from "./schema/views.ts";

/**
 * Current ranking of every seat. Survivors come first, ordered by the time-limit
 * valuation (net worth), ties broken by cash and then seat order; bankrupt seats
 * follow, the last one eliminated first.
 */
export const standings = (state: GameState): ReadonlyArray<Standing> => {
  const rows = state.players.map((current, index) => ({
    index,
    order: current.bankruptcy?.order ?? 0,
    standing: {
      seat: current.seat,
      rank: 0,
      netWorth: current.bankrupt ? 0 : netWorth(state, current.seat),
      cash: current.cash,
      bankrupt: current.bankrupt,
      bankruptAtTurn: current.bankruptcy?.turn ?? null,
    },
  }));

  rows.sort((left, right) => {
    if (left.standing.bankrupt !== right.standing.bankrupt) return left.standing.bankrupt ? 1 : -1;

    if (left.standing.bankrupt) return right.order - left.order;

    return (
      right.standing.netWorth - left.standing.netWorth ||
      right.standing.cash - left.standing.cash ||
      left.index - right.index
    );
  });

  return rows.map((row, position) => ({ ...row.standing, rank: position + 1 }));
};
