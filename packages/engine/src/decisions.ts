/** Who must act in a frame and the id of their decision. */
import { Frame } from "./schema/state.ts";

import type { Seat } from "./schema/common.ts";

interface RoundSeats {
  readonly awaiting: ReadonlyArray<Seat>;
  readonly done: ReadonlyArray<Seat>;
}

const NOBODY: ReadonlyArray<Seat> = [];

const notDone = (current: RoundSeats): ReadonlyArray<Seat> =>
  current.done.length === 0
    ? current.awaiting
    : current.awaiting.filter((seat) => !current.done.includes(seat));

/** Hoisted so that the hot path allocates no case object. */
const awaitedCases = Frame.match({
  Table: (current) => (current.phase === "collecting" ? notDone(current) : NOBODY),
  RaiseFunds: (current) => (current.phase === "collecting" ? notDone(current) : NOBODY),
  JailChoice: (current): ReadonlyArray<Seat> => [current.seat],
  BuyChoice: (current): ReadonlyArray<Seat> => [current.seat],
  Auction: notDone,
  BuildingAuction: (current) => (current.active.length > 0 ? notDone(current) : NOBODY),
  MortgagedTransfer: (current): ReadonlyArray<Seat> =>
    current.properties.length > 0 ? [current.seat] : NOBODY,
});

/** Seats that still have to answer the current round of `frame`. */
export const awaitedSeats = (frame: Frame): ReadonlyArray<Seat> => awaitedCases(frame);

const roundCases = Frame.match({
  Table: (current) => current.round,
  RaiseFunds: (current) => current.round,
  JailChoice: () => 1,
  BuyChoice: () => 1,
  Auction: (current) => current.round,
  BuildingAuction: (current) => current.round,
  MortgagedTransfer: () => 1,
});

/** Round of a frame; single-actor frames have one round. */
export const frameRound = (frame: Frame): number => roundCases(frame);

/** Decision id `<frameId>.<round>.<seat>`: unique per frame, round and seat. */
export const decisionIdFor = (frame: Frame, seat: Seat): string =>
  `${frame.id}.${frameRound(frame)}.${seat}`;
