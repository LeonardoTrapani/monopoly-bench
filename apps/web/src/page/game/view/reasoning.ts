/** The "Reasoning" tab: one card per wake (reasoning text, tool calls with ok/error, usage). */
import type { ToolCallRecord, WakeTranscript } from "@mb/api";
import type { GameConfig, Seat, WakeReason } from "@mb/engine";
import clsx from "clsx";
import { Option, Schema } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { WakeReason as WakeReasonSchema } from "@mb/engine";

import { tokens, usd } from "../../../domain/format.ts";
import { frameLabelOf, wakeReasonDescription, wakeReasonLabel } from "../../../domain/wake.ts";
import { emptyView, errorView, loadingView, seatPlayer, seatToken } from "../../../view/ui.ts";
import type { LiveWake } from "../model.ts";

/** A wake as shown in the panel, from a stored transcript or the live feed. */
export interface WakeCard {
  readonly key: string;
  readonly seat: Seat;
  readonly turn: number;
  readonly frame: string;
  readonly round: number;
  readonly reasons: ReadonlyArray<WakeReason>;
  readonly reasoning: string;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<ToolCallRecord>;
  readonly usage: Option.Option<WakeTranscript["usage"]>;
  readonly invalidActions: number;
  readonly timedOut: boolean;
  readonly isThinking: boolean;
}

const decodeReason = Schema.decodeUnknownOption(WakeReasonSchema);

export const fromTranscript = (transcript: WakeTranscript): WakeCard => ({
  key: `${transcript.seat}-${transcript.decisionId}`,
  seat: transcript.seat,
  turn: transcript.turn,
  frame: transcript.frame,
  round: transcript.round,
  reasons: transcript.reasons.flatMap((reason) => Option.toArray(decodeReason(reason))),
  reasoning: transcript.reasoning,
  text: transcript.text,
  toolCalls: transcript.toolCalls,
  usage: Option.some(transcript.usage),
  invalidActions: transcript.invalidActions,
  timedOut: transcript.timedOut,
  isThinking: false,
});

export const fromLiveWake = (wake: LiveWake): WakeCard => ({
  key: `${wake.seat}-${wake.decisionId}`,
  seat: wake.seat,
  turn: wake.turn,
  frame: wake.frame,
  round: wake.round,
  reasons: wake.reasons.flatMap((reason) => Option.toArray(decodeReason(reason))),
  reasoning: wake.reasoning,
  text: "",
  toolCalls: wake.toolCalls,
  usage: wake.usage,
  invalidActions: wake.toolCalls.filter((call) => !call.ok).length,
  timedOut: wake.timedOut,
  isThinking: !wake.isFinished,
});

const toolCallView = <M>(h: HtmlBuilder<M>, call: ToolCallRecord, index: number): Html =>
  h.keyed("li")(
    `call-${index}`,
    [
      h.Class(
        clsx(
          "rounded border px-2 py-1.5",
          call.ok ? "border-line bg-paper" : "border-red/40 bg-red/5",
        ),
      ),
    ],
    [
      h.div(
        [h.Class("flex items-start gap-2")],
        [
          h.span(
            [
              h.Class(
                clsx(
                  "mt-0.5 shrink-0 rounded px-1 text-[10px] font-bold uppercase",
                  call.ok ? "bg-money-light text-money" : "bg-red text-white",
                ),
              ),
            ],
            [call.ok ? "ok" : "error"],
          ),
          h.code(
            [h.Class("num min-w-0 text-[11px] break-all text-ink")],
            [
              h.span([h.Class("font-bold")], [call.name]),
              call.argsJson === "{}" || call.argsJson === "" ? "()" : `(${call.argsJson})`,
            ],
          ),
        ],
      ),
      call.result === ""
        ? h.empty
        : h.p([h.Class("mt-1 pl-9 text-[11px] text-muted")], [call.result]),
    ],
  );

const usageView = <M>(h: HtmlBuilder<M>, card: WakeCard): Html =>
  Option.match(card.usage, {
    onNone: () => h.empty,
    onSome: (usage) =>
      h.p(
        [h.Class("num flex flex-wrap gap-x-3 text-[11px] text-muted")],
        [
          h.span([], [`in ${tokens(usage.inputTokens)}`]),
          h.span([], [`out ${tokens(usage.outputTokens)}`]),
          usage.reasoningTokens > 0
            ? h.span([], [`reasoning ${tokens(usage.reasoningTokens)}`])
            : h.empty,
          h.span([h.Class("font-semibold text-ink-2")], [usd(usage.costUsd)]),
        ],
      ),
  });

const wakeCardView = <M>(h: HtmlBuilder<M>, card: WakeCard, labels: GameConfig["seats"]): Html =>
  h.keyed("li")(
    card.key,
    [
      h.Class(
        clsx(
          "rounded-md border-[1.5px] bg-paper p-3",
          card.isThinking ? "border-red" : "border-line",
        ),
      ),
    ],
    [
      h.div(
        [h.Class("mb-2 flex flex-wrap items-center gap-2")],
        [
          seatToken(h, seatPlayer(labels, card.seat), "sm"),
          h.span(
            [h.Class("text-sm font-semibold text-ink")],
            [seatPlayer(labels, card.seat).label],
          ),
          h.span(
            [h.Class("text-xs text-muted")],
            [`${frameLabelOf(card.frame)} · round ${card.round}`],
          ),
          ...card.reasons.map((reason: WakeReason) =>
            h.span(
              [
                h.Class(
                  "rounded bg-ink/80 px-1.5 py-px text-[10px] font-bold tracking-wide text-white uppercase",
                ),
                h.Title(wakeReasonDescription(reason)),
              ],
              [wakeReasonLabel(reason)],
            ),
          ),
          card.isThinking
            ? h.span(
                [h.Class("ml-auto inline-flex items-center gap-1 text-xs font-semibold text-red")],
                [
                  "thinking",
                  h.span([h.Class("thinking-dots")], [h.span([]), h.span([]), h.span([])]),
                ],
              )
            : h.empty,
          card.timedOut
            ? h.span(
                [
                  h.Class(
                    "ml-auto rounded bg-red px-1.5 text-[10px] font-bold text-white uppercase",
                  ),
                ],
                ["Timed out"],
              )
            : h.empty,
        ],
      ),
      card.reasoning === ""
        ? h.empty
        : h.details(
            [h.Class("group mb-2"), ...(card.isThinking ? [h.Open(true)] : [])],
            [
              h.summary(
                [
                  h.Class(
                    "cursor-pointer text-xs font-semibold text-ink-2 select-none hover:text-ink",
                  ),
                ],
                ["Reasoning"],
              ),
              h.p(
                [
                  h.Class(
                    "scroll-thin mt-1 max-h-56 overflow-y-auto rounded bg-paper-2 p-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-2",
                  ),
                ],
                [card.reasoning],
              ),
            ],
          ),
      card.text === ""
        ? h.empty
        : h.p([h.Class("mb-2 text-xs whitespace-pre-wrap text-ink")], [card.text]),
      card.toolCalls.length === 0
        ? h.empty
        : h.ol(
            [h.Class("mb-2 space-y-1")],
            card.toolCalls.map((call, index) => toolCallView(h, call, index)),
          ),
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-2")],
        [
          usageView(h, card),
          card.invalidActions > 0
            ? h.span(
                [h.Class("text-[11px] font-semibold text-red")],
                [`${card.invalidActions} invalid`],
              )
            : h.empty,
        ],
      ),
    ],
  );

export interface ReasoningInput<M> {
  readonly transcripts: AsyncData.AsyncData<ReadonlyArray<WakeTranscript>, string>;
  readonly liveWakes: ReadonlyArray<LiveWake>;
  readonly turn: number;
  readonly seats: GameConfig["seats"];
  readonly seatFilter: Option.Option<Seat>;
  readonly hasLlmSeats: boolean;
  readonly isFollowingLive: boolean;
  readonly onFilter: (value: string) => M;
  readonly retry: M;
}

const filterSelect = <M>(h: HtmlBuilder<M>, input: ReasoningInput<M>): Html =>
  h.label(
    [h.Class("flex items-center gap-2 text-xs font-semibold text-ink-2")],
    [
      "Player",
      h.select(
        [
          h.Class("rounded border border-line bg-paper px-2 py-1 text-xs text-ink"),
          h.OnChange(input.onFilter),
          h.AriaLabel("Filter wakes by player"),
        ],
        [
          h.option([h.Value("all"), h.Selected(Option.isNone(input.seatFilter))], ["All players"]),
          ...input.seats.map((seat) =>
            h.option(
              [h.Value(seat.seat), h.Selected(Option.contains(input.seatFilter, seat.seat))],
              [seat.label],
            ),
          ),
        ],
      ),
    ],
  );

export const reasoningView = <M>(h: HtmlBuilder<M>, input: ReasoningInput<M>): Html => {
  if (!input.hasLlmSeats) {
    return emptyView(
      h,
      "Bots think silently",
      "Every seat in this game is a scripted bot, so there is no reasoning to show. LLM seats record their reasoning, tool calls and cost for every wake.",
    );
  }

  const matchesSeat = (card: WakeCard): boolean =>
    Option.match(input.seatFilter, { onNone: () => true, onSome: (seat) => seat === card.seat });

  const stored = AsyncData.getOrElse(input.transcripts, () => []).map(fromTranscript);
  const storedKeys = new Set(stored.map((card) => card.key));
  const live = input.liveWakes.map(fromLiveWake).filter((card) => !storedKeys.has(card.key));

  const thinkingNow = input.isFollowingLive
    ? live.filter((card) => card.isThinking && matchesSeat(card))
    : [];

  const thisTurn = [...stored, ...live].filter(
    (card) => card.turn === input.turn && !thinkingNow.includes(card) && matchesSeat(card),
  );

  const list = (cards: ReadonlyArray<WakeCard>): Html =>
    h.ol(
      [h.Class("space-y-2")],
      cards.map((card) => wakeCardView(h, card, input.seats)),
    );

  const transcriptState = AsyncData.match(input.transcripts, {
    onIdle: () => h.empty,
    onLoading: () => loadingView(h, "Loading transcripts…", 2),
    onRefreshing: () => h.empty,
    onFailure: (error) => errorView(h, error, input.retry),
    onStale: ({ error }) => errorView(h, error, input.retry),
    onSuccess: () => h.empty,
  });

  return h.div(
    [h.Class("space-y-3")],
    [
      h.div(
        [h.Class("flex flex-wrap items-center justify-between gap-2")],
        [
          h.p([h.Class("text-xs text-muted")], [`Wakes during turn ${input.turn}`]),
          filterSelect(h, input),
        ],
      ),
      transcriptState,
      thinkingNow.length === 0
        ? h.empty
        : h.div(
            [h.Class("space-y-2")],
            [h.p([h.Class("deed-kicker text-red")], ["Thinking now"]), list(thinkingNow)],
          ),
      thisTurn.length === 0
        ? emptyView(
            h,
            "No wakes this turn",
            "Nobody with a model was asked to act during this turn (or transcripts are not available yet). Move the timeline to another turn.",
          )
        : list(thisTurn),
    ],
  );
};
