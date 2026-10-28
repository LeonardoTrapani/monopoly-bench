/** The "Log" tab: the engine's English digest of recent turns, newest first. */
import { digest, type GameEvent } from "@mb/engine";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Replay } from "../../../domain/replay.ts";
import { playerTag, seatPlayer, seatToken, type SeatPlayer } from "../../../view/ui.ts";

/** Turns shown in the log before the cursor's turn. */
const TURNS_SHOWN = 12;

/**
 * A digest line with its seat letters (`A rolled…`, `…to C.`) shown as the players' tags. The
 * engine digest names seats by letter (the models read it too); a lone capital A–F is a seat,
 * except the B of "B. & O. Railroad".
 */
const SEAT_IN_LINE = /\b([A-F])\b(?!\. &)/g;

export const lineWithPlayers = <M>(
  h: HtmlBuilder<M>,
  line: string,
  players: ReadonlyArray<SeatPlayer>,
): ReadonlyArray<Html | string> => {
  const parts: Array<Html | string> = [];
  let last = 0;

  for (const match of line.matchAll(SEAT_IN_LINE)) {
    const player = players.find((candidate) => candidate.seat === match[1]);

    if (player === undefined) continue;

    parts.push(line.slice(last, match.index), playerTag(h, player));
    last = match.index + match[0].length;
  }

  parts.push(line.slice(last));

  return parts;
};

export const logView = <M>(
  h: HtmlBuilder<M>,
  replay: Replay,
  cursor: number,
  turnPosition: number,
): Html => {
  const first = Math.max(0, turnPosition - TURNS_SHOWN + 1);
  const blocks: Array<Html> = [];

  for (let position = turnPosition; position >= first; position -= 1) {
    const mark = replay.turns[position];

    if (mark === undefined) continue;

    const end = Math.min(cursor, replay.turns[position + 1]?.index ?? replay.events.length);
    const events: ReadonlyArray<GameEvent> = replay.events.slice(mark.index, end);
    const lines = digest(events, 0, "spectator");

    blocks.push(
      h.keyed("li")(
        `turn-${mark.turn}`,
        [h.Class("relative border-l-2 border-line pb-3 pl-5")],
        [
          h.span(
            [h.Class("absolute top-0 -left-[13px]")],
            [seatToken(h, seatPlayer(replay.config.seats, mark.seat), "sm")],
          ),
          h.p(
            [h.Class("num mb-1 text-[11px] font-bold tracking-wider text-muted uppercase")],
            [`Turn ${mark.turn} · round ${mark.gameRound}`],
          ),
          h.ul(
            [h.Class("space-y-0.5 text-xs text-ink-2")],
            lines.map((line) => h.li([], lineWithPlayers(h, line, replay.config.seats))),
          ),
        ],
      ),
    );
  }

  const preamble =
    replay.turns[0] === undefined ? replay.events : replay.events.slice(0, replay.turns[0].index);

  return h.ol(
    [h.Class("scroll-thin max-h-[32rem] space-y-1 overflow-y-auto pt-1 pr-2 pl-4")],
    blocks.length === 0
      ? digest(preamble.slice(0, cursor), 0, "spectator").map((line) =>
          h.li([h.Class("text-xs text-muted")], lineWithPlayers(h, line, replay.config.seats)),
        )
      : blocks,
  );
};
