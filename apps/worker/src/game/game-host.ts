/**
 * GameDO logic (SPEC.md §7.1), independent of the Durable Object runtime: the only writer of a
 * game's state. It keeps config, event log, snapshot, per-seat cursors, notes, decision
 * deadlines and idempotent call results in the object's SQLite; applies commands through the
 * engine seam; runs bot seats in-process; wakes LLM seats through PlayerDO; broadcasts to
 * spectators; writes summaries to D1; archives to R2 at the end; and notifies its RunDO.
 */
import {
  buildSystemPrompt,
  DEFAULT_PROMPT_SETTINGS,
  isToolArgs,
  renderWakeMessage,
} from "@mb/agent";
import { GameStatus, type LlmSeat, type Seat, type SeatActivity, WakeTranscript } from "@mb/api";
import { Match, Result, Schema } from "effect";

import {
  type ChargeResult,
  encodeSpectatorMessage,
  GameStart,
  type GameOutcome,
  type PlannedSeat,
  type SeatCall,
  SeatCallResult,
  SpectatorMessage,
  type WakeReport,
  type WakeRequest,
} from "../contracts.ts";
import type { FinishedGame, WakeRow } from "../db/writes.ts";
import { jsonColumn, queryFirst, queryRows, type SqlPort } from "../sql.ts";
import type { EngineBinding, EngineEvent, Json, PendingDecision } from "./engine.ts";

/** Bot moves applied per invocation before yielding to a fresh alarm (CPU limits). */
export const MAX_STEPS_PER_SETTLE = 500;

/** Extra time after a wake's own timeout before GameDO applies the default action. */
export const WAKE_GRACE_MS = 30_000;

const FINISH_RETRY_MS = 30_000;

const NOTES_MAX_CHARS = 2000;

export interface GameDbPort {
  readonly markRunning: (gameId: string, at: string) => Promise<void>;
  readonly progress: (gameId: string, turn: number, round: number, at: string) => Promise<void>;
  readonly recordWake: (row: WakeRow) => Promise<void>;
  readonly finish: (game: FinishedGame) => Promise<void>;
}

export interface ArchivePort {
  readonly put: (key: string, body: string, contentType: string) => Promise<void>;
}

export interface PlayersPort {
  readonly wake: (request: WakeRequest) => Promise<void>;
}

export interface RunLinkPort {
  readonly charge: (
    runId: string,
    gameId: string,
    key: string,
    costUsd: number,
  ) => Promise<ChargeResult>;
  readonly gameFinished: (runId: string, outcome: GameOutcome) => Promise<void>;
}

export interface GameHostPorts {
  readonly sql: SqlPort;
  readonly db: GameDbPort;
  readonly archive: ArchivePort;
  readonly players: PlayersPort;
  readonly run: RunLinkPort;
  readonly broadcast: (message: string) => void;
  /** Replace the object's single alarm; `null` clears it. */
  readonly setAlarm: (at: number | null) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string, cause?: unknown) => void;
}

export const archiveKeys = {
  events: (gameId: string) => `games/${gameId}/events.jsonl`,
  summary: (gameId: string) => `games/${gameId}/summary.json`,
  seat: (gameId: string, seat: Seat) => `games/${gameId}/seats/${seat}.jsonl`,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, turn INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cursors (seat TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes (seat TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions (
  seat TEXT NOT NULL, decision_id TEXT NOT NULL, status TEXT NOT NULL,
  deadline INTEGER NOT NULL, PRIMARY KEY (seat, decision_id)
);
CREATE TABLE IF NOT EXISTS calls (
  seat TEXT NOT NULL, decision_id TEXT NOT NULL, call_id TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (seat, decision_id, call_id)
);
CREATE TABLE IF NOT EXISTS transcripts (
  seat TEXT NOT NULL, decision_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (seat, decision_id)
);
`;

const ValueRow = Schema.Struct({ value: Schema.String });

const JsonRow = Schema.Struct({ json: Schema.String });

const SeqRow = Schema.Struct({ seq: Schema.NullOr(Schema.Int) });

const TextRow = Schema.Struct({ text: Schema.String });

const DeadlineRow = Schema.Struct({
  seat: Schema.String,
  decision_id: Schema.String,
  deadline: Schema.Number,
});

const NextRow = Schema.Struct({ deadline: Schema.NullOr(Schema.Number) });

const parseJson = jsonColumn(Schema.Json);

const decodeStart = jsonColumn(GameStart);

const encodeStart = Schema.encodeSync(Schema.fromJsonString(GameStart));

const decodeCallResult = jsonColumn(SeatCallResult);

const encodeCallResult = Schema.encodeSync(Schema.fromJsonString(SeatCallResult));

const encodeTranscript = Schema.encodeSync(Schema.fromJsonString(WakeTranscript));

const decodeTranscript = jsonColumn(WakeTranscript);

const stringify = (value: Json): string => JSON.stringify(value);

const refusal = (message: string, terminal: boolean): SeatCallResult => ({
  ok: false,
  message,
  terminal,
});

type HostStatus = GameStatus;

const isGameStatus = Schema.is(GameStatus);

export class GameHost<S, E extends EngineEvent, C> {
  private game: GameStart | undefined;
  private state: S | undefined;
  private settling = false;
  private dirty = false;
  private continueLater = false;
  private finishPending = false;
  private progressTurn = -1;

  constructor(
    private readonly ports: GameHostPorts,
    private readonly binding: EngineBinding<S, E, C>,
  ) {
    ports.sql.exec(SCHEMA);
    const start = this.getMeta("start");
    this.game = start === undefined ? undefined : decodeStart(start);
    const snapshot = queryFirst(ports.sql, JsonRow, "SELECT json FROM snapshot WHERE id = 1");
    this.state =
      snapshot === undefined ? undefined : binding.codec.decodeState(parseJson(snapshot.json));
    this.finishPending =
      this.status() !== "running" &&
      this.getMeta("finishedNotified") === undefined &&
      this.game !== undefined;
  }

  // ── public surface (called by the Durable Object adapter) ──────────────────────────────

  status(): HostStatus {
    const status = this.getMeta("status");

    return isGameStatus(status) ? status : "queued";
  }

  /** RunDO → GameDO. Idempotent: a second start of the same game is ignored. */
  async start(input: GameStart): Promise<void> {
    if (this.game !== undefined) return;

    const { engine, codec } = this.binding;

    const created = engine.newGame({
      seed: input.seed,
      seats: input.seats.map((seat) => seat.seat),
      maxRounds: input.maxRounds,
      tableFrequency: input.tableFrequency,
    });

    this.ports.sql.transaction(() => {
      this.setMeta("start", encodeStart(input));
      this.setMeta("status", "running");
      this.setMeta("budgetExhausted", input.budgetExhausted ? "1" : "0");
      this.persist(created.events, created.state);
    });
    this.game = input;
    this.state = created.state;
    this.broadcastEvents(created.events.map((event) => codec.encodeEvent(event)));

    try {
      await this.ports.db.markRunning(input.gameId, this.iso());
    } catch (cause) {
      this.ports.log(`D1 markRunning failed for ${input.gameId}`, cause);
    }

    await this.kick();
  }

  /** PlayerDO → GameDO for every tool except `done` and `inspect`. */
  async submit(call: SeatCall): Promise<SeatCallResult> {
    return this.handleCall(call);
  }

  async done(call: SeatCall): Promise<SeatCallResult> {
    return this.handleCall({ ...call, tool: "done", args: {} });
  }

  async inspect(call: SeatCall): Promise<SeatCallResult> {
    return this.handleCall({ ...call, tool: "inspect" });
  }

  /** PlayerDO → GameDO when a wake ends. Idempotent per (seat, decisionId). */
  async wakeFinished(report: WakeReport): Promise<void> {
    const game = this.game;

    if (game === undefined) return;

    const seen = queryFirst(
      this.ports.sql,
      JsonRow,
      "SELECT json FROM transcripts WHERE seat = ? AND decision_id = ?",
      report.seat,
      report.decisionId,
    );

    if (seen !== undefined) return;

    this.ports.sql.exec(
      "INSERT INTO transcripts (seat, decision_id, at, json) VALUES (?, ?, ?, ?)",
      report.seat,
      report.decisionId,
      this.ports.now(),
      encodeTranscript(report.transcript),
    );

    const planned = this.seatOf(report.seat);
    const { transcript } = report;

    try {
      await this.ports.db.recordWake({
        gameId: game.gameId,
        seat: report.seat,
        decisionId: report.decisionId,
        competitorId: planned?.competitorId ?? report.seat,
        turn: transcript.turn,
        kind: transcript.frame,
        round: transcript.round,
        reasons: transcript.reasons,
        startedAt: transcript.startedAt,
        latencyMs: report.latencyMs,
        inputTokens: transcript.usage.inputTokens,
        outputTokens: transcript.usage.outputTokens,
        reasoningTokens: transcript.usage.reasoningTokens,
        costUsd: transcript.usage.costUsd,
        toolCalls: transcript.toolCalls.length,
        invalidActions: transcript.invalidActions,
        timedOut: transcript.timedOut,
        endReason: report.endReason,
      });
    } catch (cause) {
      this.ports.log(`D1 recordWake failed for ${game.gameId}/${report.seat}`, cause);
    }

    try {
      const charged = await this.ports.run.charge(
        game.runId,
        game.gameId,
        `${game.gameId}:${report.seat}:${report.decisionId}`,
        transcript.usage.costUsd,
      );

      if (charged.exhausted) this.setMeta("budgetExhausted", "1");
    } catch (cause) {
      this.ports.log(`RunDO charge failed for ${game.gameId}`, cause);
    }

    // The wake ended without answering: apply the default now instead of at the deadline.
    this.timeoutIfAwaited(report.seat, report.decisionId);
    this.ports.sql.exec(
      "UPDATE decisions SET status = 'reported' WHERE seat = ? AND decision_id = ?",
      report.seat,
      report.decisionId,
    );
    await this.kick();
  }

  /** PlayerDO → GameDO: live reasoning and tool calls for spectators (not stored). */
  activity(activity: SeatActivity): void {
    this.ports.broadcast(
      encodeSpectatorMessage(SpectatorMessage.cases.Activity.make({ activity })),
    );
  }

  /** RunDO → GameDO: the run's budget is spent; the next LLM wake aborts the game. */
  async budgetExhausted(): Promise<void> {
    this.setMeta("budgetExhausted", "1");
    await this.kick();
  }

  /** RunDO → GameDO (cancel, budget): end the game now. */
  async abort(reason: string): Promise<void> {
    if (this.status() !== "running") return;

    this.applyCommand(this.binding.engine.abortCommand(reason));
    await this.kick();
  }

  async alarm(): Promise<void> {
    if (this.game === undefined || this.state === undefined) return;

    this.expireDeadlines();
    await this.settle();
  }

  /** Events with `seq > since`, one JSON value per line (the `events.jsonl` format). */
  eventsSince(since: number): string {
    const rows = queryRows(
      this.ports.sql,
      JsonRow,
      "SELECT json FROM events WHERE seq > ? ORDER BY seq",
      since,
    );

    return rows.map((row) => `${row.json}\n`).join("");
  }

  helloMessage(): string {
    const view = this.state === undefined ? null : this.binding.engine.spectatorView(this.state);

    return encodeSpectatorMessage(
      SpectatorMessage.cases.Hello.make({
        gameId: this.game?.gameId ?? "",
        status: this.status(),
        lastSeq: this.lastSeq(),
        view,
      }),
    );
  }

  // ── tool calls ─────────────────────────────────────────────────────────────────────────

  private async handleCall(call: SeatCall): Promise<SeatCallResult> {
    const cached = queryFirst(
      this.ports.sql,
      JsonRow,
      "SELECT json FROM calls WHERE seat = ? AND decision_id = ? AND call_id = ?",
      call.seat,
      call.decisionId,
      call.callId,
    );

    if (cached !== undefined) return decodeCallResult(cached.json);

    const result = this.executeCall(call);

    if (result.terminal && result.ok) {
      this.ports.sql.exec(
        "UPDATE decisions SET status = 'answered' WHERE seat = ? AND decision_id = ?",
        call.seat,
        call.decisionId,
      );
      await this.kick();
    }

    return result;
  }

  /** Synchronous: the state read, the engine call and the writes happen without interleaving. */
  private executeCall(call: SeatCall): SeatCallResult {
    const remember = (result: SeatCallResult): SeatCallResult => {
      this.ports.sql.exec(
        "INSERT OR IGNORE INTO calls (seat, decision_id, call_id, json) VALUES (?, ?, ?, ?)",
        call.seat,
        call.decisionId,
        call.callId,
        encodeCallResult(result),
      );

      return result;
    };

    const state = this.state;

    if (this.game === undefined || state === undefined)
      return refusal("The game has not started.", true);

    if (this.status() !== "running") return remember(refusal("The game is over.", true));

    const decision = this.findDecision(state, call.seat, call.decisionId);

    if (decision === undefined) {
      return remember(
        refusal(
          "This decision is closed (answered, timed out or superseded). Wait for your next wake.",
          true,
        ),
      );
    }

    if (call.tool === "inspect") {
      return isToolArgs("inspect", call.args)
        ? remember({
            ok: true,
            message: this.binding.seats.inspect(state, call.seat, call.args),
            terminal: false,
          })
        : remember(refusal("Invalid arguments for inspect.", false));
    }

    if (call.tool === "note") {
      if (!isToolArgs("note", call.args))
        return remember(refusal("Invalid arguments for note.", false));

      const text = call.args.text.slice(0, NOTES_MAX_CHARS);
      this.ports.sql.exec(
        "INSERT OR REPLACE INTO notes (seat, text) VALUES (?, ?)",
        call.seat,
        text,
      );

      return remember({
        ok: true,
        message: `Notes saved (${text.length} characters).`,
        terminal: false,
      });
    }

    if (!isToolArgs(call.tool, call.args)) {
      return remember(refusal(`Invalid arguments for ${call.tool}.`, false));
    }

    const command = this.binding.seats.commandFromTool(state, decision, call.tool, call.args);

    if (Result.isFailure(command)) return remember(refusal(command.failure, false));

    const applied = this.binding.engine.apply(state, command.success);

    if (Result.isFailure(applied)) return remember(refusal(applied.failure, false));

    const terminal =
      this.findDecision(applied.success.state, call.seat, call.decisionId) === undefined;

    const result: SeatCallResult = {
      ok: true,
      message: this.describeApplied(applied.success.events, call.seat),
      terminal,
    };

    this.ports.sql.transaction(() => {
      this.persist(applied.success.events, applied.success.state);
      remember(result);
    });
    this.state = applied.success.state;
    this.afterApply(applied.success.events);

    return result;
  }

  private describeApplied(events: ReadonlyArray<E>, seat: Seat): string {
    const lines = this.binding.engine.digest(
      events.filter((event) => this.binding.engine.visibleTo(event, seat)),
      0,
      seat,
    );

    return lines.length === 0 ? "Accepted." : lines.join("\n");
  }

  // ── engine plumbing ───────────────────────────────────────────────────────────────────

  private findDecision(state: S, seat: Seat, decisionId: string): PendingDecision | undefined {
    return this.binding.engine
      .pending(state)
      .decisions.find((decision) => decision.seat === seat && decision.decisionId === decisionId);
  }

  /** Apply a host command (bot move, timeout, abort). Returns false if the engine refused it. */
  private applyCommand(command: C): boolean {
    const state = this.state;

    if (state === undefined) return false;

    const applied = this.binding.engine.apply(state, command);

    if (Result.isFailure(applied)) return false;

    this.ports.sql.transaction(() => this.persist(applied.success.events, applied.success.state));
    this.state = applied.success.state;
    this.afterApply(applied.success.events);

    return true;
  }

  private persist(events: ReadonlyArray<E>, state: S): void {
    const { codec } = this.binding;

    for (const event of events) {
      this.ports.sql.exec(
        "INSERT INTO events (seq, turn, json) VALUES (?, ?, ?)",
        event.seq,
        event.turn,
        stringify(codec.encodeEvent(event)),
      );
    }

    this.ports.sql.exec(
      "INSERT OR REPLACE INTO snapshot (id, seq, json) VALUES (1, ?, ?)",
      this.lastSeq(),
      stringify(codec.encodeState(state)),
    );
  }

  private afterApply(events: ReadonlyArray<E>): void {
    this.broadcastEvents(events.map((event) => this.binding.codec.encodeEvent(event)));

    const state = this.state;

    if (state !== undefined && this.binding.engine.standings(state).finished) {
      const status =
        this.binding.engine.standings(state).endReason === "aborted" ? "aborted" : "finished";

      this.setMeta("status", status);
      this.finishPending = true;
    }
  }

  private broadcastEvents(events: ReadonlyArray<Json>): void {
    if (events.length === 0) return;

    this.ports.broadcast(encodeSpectatorMessage(SpectatorMessage.cases.Events.make({ events })));
  }

  private timeoutIfAwaited(seat: Seat, decisionId: string): void {
    const state = this.state;

    if (state === undefined || this.findDecision(state, seat, decisionId) === undefined) return;

    this.applyCommand(this.binding.engine.timeoutCommand(seat, decisionId));
  }

  private expireDeadlines(): void {
    const due = queryRows(
      this.ports.sql,
      DeadlineRow,
      "SELECT seat, decision_id, deadline FROM decisions WHERE status = 'dispatched' AND deadline <= ?",
      this.ports.now(),
    );

    for (const row of due) {
      const seat = this.seatOf(row.seat);

      if (seat !== undefined) this.timeoutIfAwaited(seat.seat, row.decision_id);

      this.ports.sql.exec(
        "UPDATE decisions SET status = 'expired' WHERE seat = ? AND decision_id = ?",
        row.seat,
        row.decision_id,
      );
    }
  }

  // ── the settle loop ───────────────────────────────────────────────────────────────────

  /** Re-run the settle loop soon: inline if one is running, otherwise through the alarm. */
  private async kick(): Promise<void> {
    if (this.settling) {
      this.dirty = true;

      return;
    }

    await this.ports.setAlarm(this.ports.now());
  }

  /**
   * Advance the game until it needs LLM input: apply bot moves, dispatch wakes for undecided
   * LLM seats, finish the game when it ends. Never runs twice at once; calls that arrive
   * while it awaits mark it dirty and it loops again.
   */
  private async settle(): Promise<void> {
    if (this.settling) {
      this.dirty = true;

      return;
    }

    this.settling = true;

    try {
      do {
        this.dirty = false;
        this.continueLater = false;
        await this.settleOnce();
      } while (this.dirty);

      await this.flushProgress();
    } finally {
      this.settling = false;
    }

    await this.armAlarm();
  }

  private async settleOnce(): Promise<void> {
    const game = this.game;

    for (let steps = 0; game !== undefined;) {
      const state = this.state;

      if (state === undefined) return;

      if (this.finishPending || this.status() !== "running") {
        await this.finish();

        return;
      }

      const pending = this.binding.engine.pending(state).decisions;
      const botDecision = pending.find((decision) => this.seatOf(decision.seat)?.kind === "bot");

      if (botDecision !== undefined) {
        if (steps >= MAX_STEPS_PER_SETTLE) {
          this.continueLater = true;

          return;
        }

        steps += 1;
        this.playBot(state, botDecision);
        continue;
      }

      for (const decision of pending) {
        if (this.status() !== "running") break;

        await this.dispatch(decision);
      }

      if (this.finishPending) continue;

      return;
    }
  }

  private playBot(state: S, decision: PendingDecision): void {
    const seat = this.seatOf(decision.seat);

    const policy =
      seat === undefined
        ? "random"
        : Match.valueTags(seat.spec, { bot: (bot) => bot.policy, llm: () => "random" as const });

    const moved = this.applyCommand(this.binding.seats.botCommand(state, decision, policy));

    // A bot proposing an illegal move must not stall the game: take the default instead.
    if (
      !moved &&
      !this.applyCommand(this.binding.engine.timeoutCommand(decision.seat, decision.decisionId))
    ) {
      this.ports.log(
        `Bot move and default both refused for ${decision.seat} ${decision.decisionId}`,
      );
      this.applyCommand(this.binding.engine.abortCommand("engine refused the default action"));
    }
  }

  private async dispatch(decision: PendingDecision): Promise<void> {
    const game = this.game;
    const state = this.state;
    const seat = this.seatOf(decision.seat);

    if (game === undefined || state === undefined || seat === undefined) return;

    const known = queryFirst(
      this.ports.sql,
      DeadlineRow,
      "SELECT seat, decision_id, deadline FROM decisions WHERE seat = ? AND decision_id = ?",
      decision.seat,
      decision.decisionId,
    );

    if (known !== undefined) return;

    if (this.getMeta("budgetExhausted") === "1") {
      this.applyCommand(this.binding.engine.abortCommand("budget exhausted"));

      return;
    }

    const spec = Match.valueTags(seat.spec, { llm: (llm) => llm, bot: () => undefined });

    if (spec === undefined) return;

    const request = this.wakeRequest(game, state, decision, spec);

    this.ports.sql.transaction(() => {
      this.ports.sql.exec(
        "INSERT INTO decisions (seat, decision_id, status, deadline) VALUES (?, ?, 'dispatched', ?)",
        decision.seat,
        decision.decisionId,
        request.deadline,
      );
      this.ports.sql.exec(
        "INSERT OR REPLACE INTO cursors (seat, seq) VALUES (?, ?)",
        decision.seat,
        this.lastSeq(),
      );
    });

    try {
      await this.ports.players.wake(request);
    } catch (cause) {
      this.ports.log(`PlayerDO wake failed for ${game.gameId}/${decision.seat}`, cause);
      this.timeoutIfAwaited(decision.seat, decision.decisionId);
    }
  }

  private wakeRequest(
    game: GameStart,
    state: S,
    decision: PendingDecision,
    spec: LlmSeat,
  ): WakeRequest {
    const { engine, seats } = this.binding;

    const cursor = queryFirst(
      this.ports.sql,
      SeqRow,
      "SELECT seq FROM cursors WHERE seat = ?",
      decision.seat,
    );

    const since = cursor?.seq ?? 0;

    const events = this.eventsAfter(since).filter((event) =>
      engine.visibleTo(event, decision.seat),
    );

    const context = seats.wakeContext(state, decision);

    const notes = queryFirst(
      this.ports.sql,
      TextRow,
      "SELECT text FROM notes WHERE seat = ?",
      decision.seat,
    );

    const message = renderWakeMessage({
      seat: decision.seat,
      roster: game.seats.map((seat) => ({ seat: seat.seat, label: seat.label })),
      turn: engine.pending(state).turn,
      digest: engine.digest(events, since, decision.seat),
      view: context.view,
      question: {
        frame: decision.frame,
        round: decision.round,
        reasons: decision.reasons,
        legal: decision.legal,
        prompt: context.question,
      },
      offers: context.offers,
      notes: notes?.text ?? "",
    });

    const systemPrompt = buildSystemPrompt({
      ...DEFAULT_PROMPT_SETTINGS,
      playersCount: game.playersCount,
      maxRounds: game.maxRounds,
      tableFrequency: game.tableFrequency,
      limits: game.limits,
    });

    return {
      gameId: game.gameId,
      runId: game.runId,
      seat: decision.seat,
      decisionId: decision.decisionId,
      sessionKey: decision.sessionKey,
      turn: engine.pending(state).turn,
      frame: decision.frame,
      round: decision.round,
      reasons: decision.reasons,
      spec,
      listing: game.listings.find((listing) => listing.id === spec.model) ?? null,
      systemPrompt,
      message,
      limits: game.limits,
      deadline: this.ports.now() + game.limits.wakeTimeoutMs + WAKE_GRACE_MS,
    };
  }

  private async flushProgress(): Promise<void> {
    const game = this.game;
    const state = this.state;

    if (game === undefined || state === undefined || this.status() !== "running") return;

    const pending = this.binding.engine.pending(state);

    if (pending.turn === this.progressTurn) return;

    this.progressTurn = pending.turn;

    try {
      await this.ports.db.progress(game.gameId, pending.turn, pending.round, this.iso());
    } catch (cause) {
      this.ports.log(`D1 progress failed for ${game.gameId}`, cause);
    }
  }

  private async armAlarm(): Promise<void> {
    if (this.continueLater || this.dirty) {
      await this.ports.setAlarm(this.ports.now());

      return;
    }

    if (this.finishPending) {
      await this.ports.setAlarm(this.ports.now() + FINISH_RETRY_MS);

      return;
    }

    const next = queryFirst(
      this.ports.sql,
      NextRow,
      "SELECT MIN(deadline) AS deadline FROM decisions WHERE status = 'dispatched'",
    );

    await this.ports.setAlarm(this.status() === "running" ? (next?.deadline ?? null) : null);
  }

  // ── the end of a game ─────────────────────────────────────────────────────────────────

  private async finish(): Promise<void> {
    const game = this.game;
    const state = this.state;

    if (
      game === undefined ||
      state === undefined ||
      this.getMeta("finishedNotified") !== undefined
    ) {
      this.finishPending = false;

      return;
    }

    const { engine, seats, codec } = this.binding;
    const standings = engine.standings(state);

    const status =
      standings.endReason === "aborted" || !standings.finished ? "aborted" : "finished";

    const events = this.eventsAfter(0);
    const records = seats.records(state, events);
    const finishedAt = this.iso();

    const competitorOf = (seat: Seat | null): string | null =>
      seat === null ? null : (this.seatOf(seat)?.competitorId ?? seat);

    const counterOf = (seat: Seat) => records.counters.find((counter) => counter.seat === seat);
    const pending = engine.pending(state);

    try {
      await this.ports.archive.put(
        archiveKeys.events(game.gameId),
        events.map((event) => `${stringify(codec.encodeEvent(event))}\n`).join(""),
        "application/x-ndjson",
      );

      for (const seat of game.seats) {
        const transcripts = queryRows(
          this.ports.sql,
          JsonRow,
          "SELECT json FROM transcripts WHERE seat = ? ORDER BY at, decision_id",
          seat.seat,
        );

        await this.ports.archive.put(
          archiveKeys.seat(game.gameId, seat.seat),
          transcripts.map((row) => `${encodeTranscript(decodeTranscript(row.json))}\n`).join(""),
          "application/x-ndjson",
        );
      }

      await this.ports.archive.put(
        archiveKeys.summary(game.gameId),
        JSON.stringify(
          {
            gameId: game.gameId,
            runId: game.runId,
            seed: game.seed,
            engine: engine.version,
            status,
            endReason: standings.endReason,
            winner: standings.winner,
            finishedAt,
            seats: game.seats.map((seat) => ({
              seat: seat.seat,
              competitorId: seat.competitorId,
              label: seat.label,
              kind: seat.kind,
              standing: standings.seats.find((standing) => standing.seat === seat.seat) ?? null,
              notes:
                queryFirst(
                  this.ports.sql,
                  TextRow,
                  "SELECT text FROM notes WHERE seat = ?",
                  seat.seat,
                )?.text ?? "",
            })),
            records: { offers: records.offers.length, auctions: records.auctions.length },
          },
          null,
          2,
        ),
        "application/json",
      );

      await this.ports.db.finish({
        gameId: game.gameId,
        status,
        endReason: standings.endReason ?? "aborted",
        winnerSeat: standings.winner,
        finishedAt,
        turn: pending.turn,
        round: pending.round,
        seats: standings.seats.map((standing) => ({
          seat: standing.seat,
          rank: standing.rank,
          netWorth: standing.netWorth,
          cash: standing.cash,
          bankruptAtTurn: standing.bankruptAtTurn,
          propertiesBought: counterOf(standing.seat)?.propertiesBought ?? 0,
          housesBuilt: counterOf(standing.seat)?.housesBuilt ?? 0,
          hotelsBuilt: counterOf(standing.seat)?.hotelsBuilt ?? 0,
          mortgages: counterOf(standing.seat)?.mortgages ?? 0,
          jailTurns: counterOf(standing.seat)?.jailTurns ?? 0,
        })),
        offers: records.offers.map((offer) => ({
          offerId: offer.offerId,
          turn: offer.turn,
          round: offer.round,
          fromSeat: offer.from,
          fromCompetitor: competitorOf(offer.from) ?? offer.from,
          toSeat: offer.to,
          toCompetitor: competitorOf(offer.to),
          give: offer.give,
          get: offer.get,
          replyTo: offer.replyTo,
          comment: offer.comment,
          status: offer.status,
          acceptedBySeat: offer.acceptedBy,
          acceptedByCompetitor: competitorOf(offer.acceptedBy),
        })),
        auctions: records.auctions.map((auction) => ({
          auctionId: auction.auctionId,
          turn: auction.turn,
          kind: auction.kind,
          property: auction.property,
          listPrice: auction.listPrice,
          winnerSeat: auction.winner,
          winnerCompetitor: competitorOf(auction.winner),
          price: auction.price,
          bids: auction.bids,
        })),
      });

      await this.ports.run.gameFinished(game.runId, {
        gameId: game.gameId,
        status,
        playersCount: game.playersCount,
        finishedAt,
        results: game.seats.map((seat) => ({
          seat: seat.seat,
          competitorId: seat.competitorId,
          label: seat.label,
          kind: seat.kind,
          rank:
            status === "finished"
              ? (standings.seats.find((standing) => standing.seat === seat.seat)?.rank ?? null)
              : null,
        })),
      });
    } catch (cause) {
      this.ports.log(`Finishing ${game.gameId} failed; retrying`, cause);

      return;
    }

    this.setMeta("finishedNotified", finishedAt);
    this.setMeta("status", status);
    this.finishPending = false;
    this.ports.broadcast(encodeSpectatorMessage(SpectatorMessage.cases.Status.make({ status })));
  }

  // ── small helpers ─────────────────────────────────────────────────────────────────────

  private eventsAfter(since: number): ReadonlyArray<E> {
    return queryRows(
      this.ports.sql,
      JsonRow,
      "SELECT json FROM events WHERE seq > ? ORDER BY seq",
      since,
    ).map((row) => this.binding.codec.decodeEvent(parseJson(row.json)));
  }

  private lastSeq(): number {
    return queryFirst(this.ports.sql, SeqRow, "SELECT MAX(seq) AS seq FROM events")?.seq ?? 0;
  }

  private seatOf(seat: string): PlannedSeat | undefined {
    return this.game?.seats.find((planned) => planned.seat === seat);
  }

  private getMeta(key: string): string | undefined {
    return queryFirst(this.ports.sql, ValueRow, "SELECT value FROM meta WHERE key = ?", key)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.ports.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  private iso(): string {
    return new Date(this.ports.now()).toISOString();
  }
}
