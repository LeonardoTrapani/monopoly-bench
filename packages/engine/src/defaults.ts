/** Default actions (SPEC §6.5) and the automatic liquidation plan. */
import { topFrame } from "./access.ts";
import { awaitedSeats, decisionIdFor } from "./decisions.ts";
import { liquidate } from "./flow.ts";
import { Machine } from "./machine.ts";
import { command } from "./schema/commands.ts";
import { Frame } from "./schema/state.ts";

import type { Command } from "./schema/commands.ts";
import type { Seat } from "./schema/common.ts";
import type { GameState } from "./schema/state.ts";
import type { LiquidationStep } from "./schema/views.ts";

/**
 * The plain command equivalent to `seat`'s default action, or null when it has no
 * pending decision: sessions → `Done`, buy → `Decline`, auctions → `PassBid`, jail →
 * `RollForDoubles`, mortgaged deeds → `KeepMortgage`. Submitting `TimeoutSeat` instead
 * applies the same defaults and, for a RaiseFunds debtor, forces automatic liquidation.
 */
export const defaultCommand = (state: GameState, seat: Seat): Command | null => {
  const frame = topFrame(state);

  if (state.status !== "playing" || frame === undefined || !awaitedSeats(frame).includes(seat)) {
    return null;
  }

  const decisionId = decisionIdFor(frame, seat);
  const answer = { seat, decisionId };

  return Frame.match(frame, {
    Table: (): Command => command("Done", answer),
    RaiseFunds: (): Command => command("Done", answer),
    JailChoice: (): Command => command("RollForDoubles", answer),
    BuyChoice: (): Command => command("Decline", answer),
    Auction: (): Command => command("PassBid", answer),
    BuildingAuction: (): Command => command("PassBid", answer),
    MortgagedTransfer: (current): Command | null => {
      const property = current.properties[0];

      return property === undefined ? null : command("KeepMortgage", { ...answer, property });
    },
  });
};

/** The host command applying `seat`'s default action, or null when it has no pending decision. */
export const timeoutCommand = (state: GameState, seat: Seat): Command | null => {
  const frame = topFrame(state);

  if (state.status !== "playing" || frame === undefined || !awaitedSeats(frame).includes(seat)) {
    return null;
  }

  return command("TimeoutSeat", { seat, decisionId: decisionIdFor(frame, seat) });
};

/**
 * Steps the engine would take to raise `amount` cash for `seat` (SPEC §6.5): sell
 * buildings evenly from the most expensive set, then mortgage from the cheapest deed.
 * Stops as soon as cash covers `amount`; may fall short.
 */
export const autoLiquidate = (
  state: GameState,
  seat: Seat,
  amount: number,
): ReadonlyArray<LiquidationStep> => {
  const steps: Array<LiquidationStep> = [];

  liquidate(new Machine(state), seat, amount, (step) => steps.push(step));

  return steps;
};
