/**
 * Wake message (SPEC.md §6.2), built only from data: what happened since the seat's last wake
 * (`digest` from its cursor), the seat's `playerView`, the question with its legal tools, the
 * session's offers and threads, and the seat's notes. No randomness, no clock.
 */
import type { DecisionRequest, PlayerView, WakeReason } from "@mb/engine";

import { toolsForKinds } from "./commands.ts";
import { renderOffers, renderPlayerView } from "./render.ts";

/** Digest lines beyond this are summarized, oldest first. */
export const MAX_DIGEST_LINES = 80;

const REASON_TEXT: Readonly<Record<WakeReason, string>> = {
  opening: "the session opened",
  addressed: "something was addressed to you",
  inThread: "a new offer in a thread you are part of",
  follows: "a new offer involves a group you follow",
  openCall: "a new open offer",
  debtor: "you owe money",
  bidder: "you are bidding",
  active: "it is your decision",
};

export interface WakeMessageInput {
  readonly view: PlayerView;
  readonly request: DecisionRequest;
  /** `digest(events, cursor, seat)`: lines since this seat's previous wake. */
  readonly digest: ReadonlyArray<string>;
  readonly notes: string;
}

const section = (title: string, body: string): string => `## ${title}\n${body}`;

const digestText = (lines: ReadonlyArray<string>): string => {
  if (lines.length === 0) return "Nothing new.";

  const kept = lines.slice(-MAX_DIGEST_LINES);
  const omitted = lines.length - kept.length;

  return [
    ...(omitted > 0 ? [`(${omitted} earlier lines omitted)`] : []),
    ...kept.map((line) => `- ${line}`),
  ].join("\n");
};

export const renderWakeMessage = (input: WakeMessageInput): string => {
  const { view, request } = input;
  const me = view.players.find((player) => player.seat === view.seat);

  const others = view.players
    .filter((player) => player.seat !== view.seat)
    .map((player) => `${player.seat} ${player.label}`)
    .join(", ");

  // Table questions already say why a later round woke the seat.
  const reasons =
    request.frame === "Table"
      ? ""
      : request.reasons.map((reason) => REASON_TEXT[reason]).join("; ");

  const legal = toolsForKinds(request.allowed);

  const answering = toolsForKinds(
    request.terminal.filter((kind) => request.allowed.includes(kind)),
  );

  return [
    `You are seat ${view.seat} (${me?.label ?? view.seat}). Opponents: ${others}.`,
    section("Since your last wake", digestText(input.digest)),
    section("Table", renderPlayerView(view)),
    section(
      "Decision",
      [
        request.question,
        `${request.frame}, round ${request.round}, turn ${request.turn}${reasons.length === 0 ? "" : `; woken because ${reasons}`}.`,
        `Legal now: ${[...legal, "inspect", "note"].join(", ")}.`,
        `End this wake with one of: ${answering.join(", ") || "done"}.`,
      ].join("\n"),
    ),
    section(
      "Offers and threads",
      view.offers.length === 0 ? "None this session." : renderOffers(view.offers),
    ),
    section("Your notes", input.notes.length === 0 ? "(empty)" : input.notes),
  ].join("\n\n");
};

/** Sent when the model stops without answering; the conversation then continues. */
export const NUDGE_MESSAGE =
  "You have not answered yet. End this wake with one of the answering tools that is legal now (see the Decision section).";
