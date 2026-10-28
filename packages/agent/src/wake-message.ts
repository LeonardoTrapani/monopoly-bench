/**
 * Wake message rendering (SPEC.md §6.2). Built only from data: the host passes the engine's
 * digest lines, the seat's rendered view, the question, the offers and the notes, and this
 * module assembles them in a fixed order. No randomness, no clock.
 */
import type { Seat } from "@mb/api";

export interface RosterEntry {
  readonly seat: Seat;
  readonly label: string;
}

export interface WakeQuestion {
  /** Engine frame name, e.g. "Table", "BuyChoice", "Auction". */
  readonly frame: string;
  readonly round: number;
  /** Why this seat was woken (SPEC §5.3), e.g. "addressed", "follows", "debtor". */
  readonly reasons: ReadonlyArray<string>;
  /** Legal command kinds for this seat, as tool names. */
  readonly legal: ReadonlyArray<string>;
  /** One or two sentences stating what must be decided. */
  readonly prompt: string;
}

export interface WakeMessageParts {
  readonly seat: Seat;
  readonly roster: ReadonlyArray<RosterEntry>;
  readonly turn: number;
  /** `digest(events, cursor, seat)` lines: what happened since the seat's last wake. */
  readonly digest: ReadonlyArray<string>;
  /** The seat's `playerView`, rendered compactly. */
  readonly view: string;
  readonly question: WakeQuestion;
  /** Open offers and threads with comments, rendered. Empty when there are none. */
  readonly offers: string;
  readonly notes: string;
}

const section = (title: string, body: string): string => `## ${title}\n${body}`;

const rosterLine = (parts: WakeMessageParts): string =>
  parts.roster
    .map((entry) =>
      entry.seat === parts.seat ? `${entry.seat} (you)` : `${entry.seat}: ${entry.label}`,
    )
    .join(", ");

export const renderWakeMessage = (parts: WakeMessageParts): string => {
  const { question } = parts;

  const reasons =
    question.reasons.length === 0 ? "" : ` Woken because: ${question.reasons.join(", ")}.`;

  return [
    `You are seat ${parts.seat}. Players: ${rosterLine(parts)}.`,
    section(
      "Since your last wake",
      parts.digest.length === 0
        ? "Nothing new."
        : parts.digest.map((line) => `- ${line}`).join("\n"),
    ),
    section("Table", parts.view),
    section(
      "Decision",
      `Turn ${parts.turn}, ${question.frame}, round ${question.round}.${reasons}\n${question.prompt}\nLegal now: ${question.legal.join(", ")}.`,
    ),
    section("Offers and threads", parts.offers.length === 0 ? "None open." : parts.offers),
    section("Your notes", parts.notes.length === 0 ? "(empty)" : parts.notes),
  ].join("\n\n");
};

/** Sent when the model stops without answering; the conversation then continues. */
export const NUDGE_MESSAGE =
  "You have not answered yet. Finish with one of the answering tools that is legal now (for example done, bid, pass_bid, buy or decline).";
