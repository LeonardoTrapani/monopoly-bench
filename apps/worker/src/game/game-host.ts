/**
 * GameDO logic (SPEC.md §7.1), independent of the Durable Object runtime: the only writer of a
 * game's state. It keeps config, event log, snapshot, per-seat cursors, notes, decision
 * deadlines and idempotent call results in the object's SQLite; applies commands through the
 * engine seam; runs bot seats in-process; wakes LLM seats through PlayerDO; broadcasts to
 * spectators; writes summaries to D1; archives to R2 at the end; and notifies its RunDO.
 */
import { isCommandTool, isToolArgs } from "@mb/agent";
import { GameStatus, type LlmSeat, Seat, type SeatActivity, WakeTranscript } from "@mb/api";
import { Deferred, Effect, Match, Result, Schema } from "effect";

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
import type { UpstreamError } from "../errors.ts";
import { jsonColumn, queryFirst, queryRows, type SqlPort } from "../sql.ts";
import type { EngineBinding, EngineEvent, Json, PendingDecision } from "./engine.ts";

/** Bot moves applied per invocation before yielding to a fresh alarm (CPU limits). */
export const MAX_STEPS_PER_SETTLE = 400;

/** Extra time after a wake's own timeout before GameDO applies the default action. */
export const WAKE_GRACE_MS = 30_000;

const FINISH_RETRY_MS = 30_000;

/**
 * Wakes in a row that one seat may end on a model error (OpenRouter refused or failed the
 * request) before the game is aborted: past this the seat is not playing, only taking the
 * default, and an aborted game is never rated (SPEC §6.5).
 */
export const MAX_CONSECUTIVE_MODEL_ERRORS = 3;

const MODEL_ERROR_MARKER = "[model error] ";

/** The model error of a wake transcript, shortened and without URLs, for an abort reason. */
const modelErrorOf = (text: string): string => {
  const at = text.lastIndexOf(MODEL_ERROR_MARKER);

  const message = (at === -1 ? "model error" : text.slice(at + MODEL_ERROR_MARKER.length))
    .replace(/https?:\/\/\S+/g, "<url>")
    .trim();

  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
};

export interface GameDbPort {
  readonly markRunning: (gameId: string, at: string) => Effect.Effect<void, UpstreamError>;
  readonly progress: (
    gameId: string,
    turn: number,
    round: number,
    at: string,
  ) => Effect.Effect<void, UpstreamError>;
  readonly recordWake: (row: WakeRow) => Effect.Effect<void, UpstreamError>;
  readonly finish: (game: FinishedGame) => Effect.Effect<void, UpstreamError>;
}

export interface ArchivePort {
  readonly put: (
    key: string,
    body: string,
    contentType: string,
  ) => Effect.Effect<void, UpstreamError>;
}

export interface PlayersPort {
  readonly wake: (request: WakeRequest) => Effect.Effect<void, UpstreamError>;
}

export interface RunLinkPort {
  readonly charge: (
    runId: string,
    gameId: string,
    key: string,
    costUsd: number,
  ) => Effect.Effect<ChargeResult, UpstreamError>;
  readonly gameFinished: (
    runId: string,
    outcome: GameOutcome,
  ) => Effect.Effect<void, UpstreamError>;
}

export interface GameHostPorts {
  readonly sql: SqlPort;
  readonly db: GameDbPort;
  readonly archive: ArchivePort;
  readonly players: PlayersPort;
  readonly run: RunLinkPort;
  readonly broadcast: (message: string) => void;
  /** Replace the object's single alarm; `null` clears it. */
  readonly setAlarm: (at: number | null) => Effect.Effect<void>;
  readonly now: () => number;
  /** Bot moves per invocation (default `MAX_STEPS_PER_SETTLE`). */
  readonly stepsPerAlarm?: number;
}

export const archiveKeys = {
  config: (gameId: string) => `games/${gameId}/config.json`,
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
  deadline INTEGER NOT NULL, dispatched_at INTEGER NOT NULL, turn INTEGER NOT NULL,
  frame TEXT NOT NULL, round INTEGER NOT NULL, reasons TEXT NOT NULL,
  PRIMARY KEY (seat, decision_id)
);
CREATE TABLE IF NOT EXISTS calls (
  seat TEXT NOT NULL, decision_id TEXT NOT NULL, call_id TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (seat, decision_id, call_id)
);
CREATE TABLE IF NOT EXISTS transcripts (
  seat TEXT NOT NULL, decision_id TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (seat, decision_id)
);
CREATE TABLE IF NOT EXISTS stale_archives (seat TEXT PRIMARY KEY);
`;

const TABLES = [
  "meta",
  "events",
  "snapshot",
  "cursors",
  "notes",
  "decisions",
  "calls",
  "transcripts",
  "stale_archives",
] as const;

const ValueRow = Schema.Struct({ value: Schema.String });

const JsonRow = Schema.Struct({ json: Schema.String });

const SnapshotRow = Schema.Struct({ seq: Schema.Int, json: Schema.String });

const SeqRow = Schema.Struct({ seq: Schema.NullOr(Schema.Int) });

const TextRow = Schema.Struct({ text: Schema.String });

const StatusRow = Schema.Struct({ status: Schema.String });

const SeatRow = Schema.Struct({ seat: Seat });

const DeadlineRow = Schema.Struct({
  seat: Schema.String,
  decision_id: Schema.String,
  deadline: Schema.Number,
  dispatched_at: Schema.Number,
  turn: Schema.Int,
  frame: Schema.String,
  round: Schema.Int,
  reasons: Schema.fromJsonString(Schema.Array(Schema.String)),
});

const NextRow = Schema.Struct({ deadline: Schema.NullOr(Schema.Number) });

const parseJson = jsonColumn(Schema.Json);

const decodeStart = jsonColumn(GameStart);

const encodeStart = Schema.encodeSync(Schema.fromJsonString(GameStart));

const decodeCallResult = jsonColumn(SeatCallResult);

const encodeCallResult = Schema.encodeSync(Schema.fromJsonString(SeatCallResult));

const encodeTranscript = Schema.encodeSync(Schema.fromJsonString(WakeTranscript));

const decodeTranscript = jsonColumn(WakeTranscript);

const encodeReasons = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const stringify = (value: Json): string => JSON.stringify(value);

const refusal = (message: string, terminal: boolean): SeatCallResult => ({
  ok: false,
  message,
  terminal,
});

const isGameStatus = Schema.is(GameStatus);

const CLOSED =
  "This decision is closed (answered, timed out or superseded). Wait for your next wake.";

export class GameHost<S, E extends EngineEvent, C> {
  private game: GameStart | undefined;
  private state: S | undefined;
  private settling = false;
  private dirty = false;
  private continueLater = false;
  private finishPending = false;
  private snapshotStale = false;
  private progressTurn = -1;
  /** The game was deleted: work still in flight must not write anything more. */
  private purged = false;
  /** R2 writes in flight: purge waits for them, so none lands after the archive is deleted. */
  private readonly archiveWrites = new Set<Deferred.Deferred<void>>();

  constructor(
    private readonly ports: GameHostPorts,
    private readonly binding: EngineBinding<S, E, C>,
  ) {
    ports.sql.exec(SCHEMA);
    const start = this.getMeta("start");
    this.game = start === undefined ? undefined : decodeStart(start);

    const snapshot = queryFirst(
      ports.sql,
      SnapshotRow,
      "SELECT seq, json FROM snapshot WHERE id = 1",
    );

    // The snapshot may lag the event log (bot moves write it once per batch): fold the rest.
    this.state =
      snapshot === undefined
        ? undefined
        : binding.engine.fold(
            binding.codec.decodeState(parseJson(snapshot.json)),
            this.eventsAfter(snapshot.seq),
          );
    this.finishPending =
      this.status() !== "running" &&
      this.getMeta("finishedNotified") === undefined &&
      this.game !== undefined;
  }

  // ── public surface (called by the Durable Object adapter) ──────────────────────────────

  status(): GameStatus {
    const status = this.getMeta("status");

    return isGameStatus(status) ? status : "queued";
  }

  /** RunDO → GameDO. Idempotent: a second start of the same game is ignored. */
  start(input: GameStart): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.game !== undefined) return;

      const created = this.binding.engine.newGame(input.config);

      this.ports.sql.transaction(() => {
        this.setMeta("start", encodeStart(input));
        this.setMeta("status", "running");
        this.setMeta("budgetExhausted", input.budgetExhausted ? "1" : "0");
        this.persistEvents(created.events);
        this.writeSnapshot(created.state);
      });
      this.game = input;
      this.state = created.state;
      this.broadcastEvents(created.events);

      yield* this.ports.db
        .markRunning(input.gameId, this.iso())
        .pipe(
          Effect.catch((cause) =>
            Effect.logError(`D1 markRunning failed for ${input.gameId}`, cause),
          ),
        );

      yield* this.kick();
    });
  }

  /** PlayerDO → GameDO for every tool except `done` and `inspect`. */
  submit(call: SeatCall): Effect.Effect<SeatCallResult> {
    return this.handleCall(call);
  }

  done(call: SeatCall): Effect.Effect<SeatCallResult> {
    return this.handleCall({ ...call, tool: "done", args: {} });
  }

  inspect(call: SeatCall): Effect.Effect<SeatCallResult> {
    return this.handleCall({ ...call, tool: "inspect" });
  }

  /** PlayerDO → GameDO when a wake ends. Idempotent per (seat, decisionId). */
  wakeFinished(report: WakeReport): Effect.Effect<void, UpstreamError> {
    return Effect.gen({ self: this }, function* () {
      const game = this.game;

      if (game === undefined) return;

      // Done only once the last step below ran: a report retried after a crash half-way through
      // redoes the missing steps, all of which are idempotent.
      const processed = queryFirst(
        this.ports.sql,
        StatusRow,
        "SELECT status FROM decisions WHERE seat = ? AND decision_id = ?",
        report.seat,
        report.decisionId,
      );

      if (processed?.status === "reported") return;

      this.ports.sql.exec(
        "INSERT OR IGNORE INTO transcripts (seat, decision_id, at, json) VALUES (?, ?, ?, ?)",
        report.seat,
        report.decisionId,
        this.ports.now(),
        encodeTranscript(report.transcript),
      );

      const { transcript } = report;

      // Accounting must succeed before the report counts as processed: a failure fails the
      // call, the decision stays unreported and PlayerDO retries the report (both writes are
      // idempotent).
      yield* this.ports.db.recordWake({
        gameId: game.gameId,
        seat: report.seat,
        decisionId: report.decisionId,
        competitorId: this.seatOf(report.seat)?.competitorId ?? report.seat,
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
        // A report arriving after GameDO's deadline is a timeout too.
        timedOut: transcript.timedOut || processed?.status === "expired",
        endReason: report.endReason,
        compactions: report.compactions,
      });

      const charged = yield* this.ports.run.charge(
        game.runId,
        game.gameId,
        `${game.gameId}:${report.seat}:${report.decisionId}`,
        transcript.usage.costUsd,
      );

      if (this.purged) return;

      if (charged.exhausted) this.setMeta("budgetExhausted", "1");

      const modelErrors = this.modelErrorStreak(report);

      if (modelErrors >= MAX_CONSECUTIVE_MODEL_ERRORS && this.status() === "running") {
        const label = this.seatOf(report.seat)?.label ?? report.seat;

        this.abortGame(
          `${label}'s model failed ${modelErrors} wakes in a row: ${modelErrorOf(transcript.text)}`,
        );
      }

      // Once the game stopped, its archive may already hold this seat's transcripts (the last
      // wake often reports after the game ends): refresh it once the game is archived.
      if (this.status() !== "running") {
        this.ports.sql.exec("INSERT OR IGNORE INTO stale_archives (seat) VALUES (?)", report.seat);
      }

      // The wake ended without answering: apply the default now instead of at the deadline.
      this.timeoutIfAwaited(report.seat, report.decisionId);
      this.ports.sql.exec(
        "UPDATE decisions SET status = 'reported' WHERE seat = ? AND decision_id = ?",
        report.seat,
        report.decisionId,
      );
      yield* this.kick();
    });
  }

  /** PlayerDO → GameDO: live reasoning and tool calls for spectators (not stored). */
  activity(activity: SeatActivity): void {
    this.ports.broadcast(
      encodeSpectatorMessage(SpectatorMessage.cases.Activity.make({ activity })),
    );
  }

  /** RunDO → GameDO: the run's budget is spent; the next LLM wake aborts the game. */
  budgetExhausted(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.setMeta("budgetExhausted", "1");
      yield* this.kick();
    });
  }

  /** RunDO → GameDO (cancel, budget): end the game now. */
  abort(reason: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.status() !== "running") return;

      this.abortGame(reason);
      yield* this.kick();
    });
  }

  /**
   * RunDO → GameDO when the run is deleted: empty every table and clear the alarm. The game is
   * forgotten: later calls find no game, and work already in flight stops before its next write
   * (no archive, no D1 summary, no run notification).
   */
  purge(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.purged = true;
      this.ports.sql.transaction(() => {
        for (const table of TABLES) this.ports.sql.exec(`DELETE FROM ${table}`);
      });
      this.game = undefined;
      this.state = undefined;
      this.finishPending = false;
      yield* this.ports.setAlarm(null);
      yield* Effect.forEach([...this.archiveWrites], Deferred.await, { discard: true });
    });
  }

  alarm(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.game === undefined || this.state === undefined) return;

      yield* this.expireDeadlines();
      yield* this.settle();
    });
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

  /** The engine `GameConfig` of the game, as JSON, or null before it starts. */
  config(): string | null {
    return this.game === undefined
      ? null
      : stringify(this.binding.codec.encodeConfig(this.game.config));
  }

  /** Wake transcripts recorded so far (one `WakeTranscript` per line), for one seat or all. */
  transcripts(seat: Seat | null): string {
    const rows =
      seat === null
        ? queryRows(this.ports.sql, JsonRow, "SELECT json FROM transcripts ORDER BY at, seat")
        : queryRows(
            this.ports.sql,
            JsonRow,
            "SELECT json FROM transcripts WHERE seat = ? ORDER BY at",
            seat,
          );

    return rows.map((row) => `${encodeTranscript(decodeTranscript(row.json))}\n`).join("");
  }

  /** `gameId` names the game for spectators who connect before it starts. */
  helloMessage(gameId: string): string {
    const view = this.state === undefined ? null : this.binding.engine.spectatorView(this.state);

    return encodeSpectatorMessage(
      SpectatorMessage.cases.Hello.make({
        gameId: this.game?.gameId ?? gameId,
        status: this.status(),
        lastSeq: this.lastSeq(),
        view,
      }),
    );
  }

  // ── tool calls ─────────────────────────────────────────────────────────────────────────

  private handleCall(call: SeatCall): Effect.Effect<SeatCallResult> {
    return Effect.gen({ self: this }, function* () {
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
        yield* this.kick();
      }

      return result;
    });
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

    if (this.game === undefined || state === undefined) {
      return refusal("The game has not started.", true);
    }

    if (this.status() !== "running") return remember(refusal("The game is over.", true));

    const decision = this.findDecision(state, call.seat, call.decisionId);

    if (decision === undefined) return remember(refusal(CLOSED, true));

    const { seats, engine } = this.binding;

    if (call.tool === "inspect") {
      return isToolArgs("inspect", call.args)
        ? remember({
            ok: true,
            message: seats.inspect(state, call.seat, call.args),
            terminal: false,
          })
        : remember(refusal("Invalid arguments for inspect.", false));
    }

    if (call.tool === "note") {
      if (!isToolArgs("note", call.args)) {
        return remember(refusal("Invalid arguments for note.", false));
      }

      const text = call.args.text.slice(0, seats.limits(state).notesMaxChars);

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

    if (!isCommandTool(call.tool) || !isToolArgs(call.tool, call.args)) {
      return remember(refusal(`Invalid arguments for ${call.tool}.`, false));
    }

    const command = seats.commandFromTool(decision, call.tool, call.args);

    if (Result.isFailure(command)) return remember(refusal(command.failure, false));

    const applied = engine.apply(state, command.success);

    if (Result.isFailure(applied)) return remember(refusal(applied.failure, false));

    const terminal = !engine.isAwaiting(applied.success.state, call.seat, call.decisionId);

    const result: SeatCallResult = {
      ok: true,
      message: seats.outcome(applied.success.events, call.seat),
      terminal,
    };

    this.ports.sql.transaction(() => {
      this.persistEvents(applied.success.events);
      this.writeSnapshot(applied.success.state);
      remember(result);
    });
    this.state = applied.success.state;
    this.afterApply(applied.success.events);

    return result;
  }

  // ── engine plumbing ───────────────────────────────────────────────────────────────────

  private findDecision(state: S, seat: Seat, decisionId: string): PendingDecision | undefined {
    if (!this.binding.engine.isAwaiting(state, seat, decisionId)) return undefined;

    return this.binding.engine
      .pending(state)
      .decisions.find((decision) => decision.seat === seat && decision.decisionId === decisionId);
  }

  /** Apply a host command (bot move, timeout, abort). Returns false if the engine refused it. */
  private applyCommand(command: C, snapshot: boolean): boolean {
    const state = this.state;

    if (state === undefined) return false;

    const applied = this.binding.engine.apply(state, command);

    if (Result.isFailure(applied)) return false;

    this.ports.sql.transaction(() => {
      this.persistEvents(applied.success.events);

      if (snapshot) this.writeSnapshot(applied.success.state);
    });
    this.state = applied.success.state;
    this.snapshotStale = !snapshot;
    this.afterApply(applied.success.events);

    return true;
  }

  private persistEvents(events: ReadonlyArray<E>): void {
    for (const event of events) {
      this.ports.sql.exec(
        "INSERT INTO events (seq, turn, json) VALUES (?, ?, ?)",
        event.seq,
        event.turn,
        stringify(this.binding.codec.encodeEvent(event)),
      );
    }
  }

  private writeSnapshot(state: S): void {
    this.ports.sql.exec(
      "INSERT OR REPLACE INTO snapshot (id, seq, json) VALUES (1, ?, ?)",
      this.lastSeq(),
      stringify(this.binding.codec.encodeState(state)),
    );
    this.snapshotStale = false;
  }

  private flushSnapshot(): void {
    if (this.snapshotStale && this.state !== undefined) this.writeSnapshot(this.state);
  }

  private afterApply(events: ReadonlyArray<E>): void {
    this.broadcastEvents(events);

    const state = this.state;

    if (state === undefined) return;

    const standings = this.binding.engine.standings(state);

    if (standings.finished) {
      this.setMeta("status", standings.endReason === "aborted" ? "aborted" : "finished");
      this.finishPending = true;
    }
  }

  private broadcastEvents(events: ReadonlyArray<E>): void {
    if (events.length === 0) return;

    this.ports.broadcast(
      encodeSpectatorMessage(
        SpectatorMessage.cases.Events.make({
          events: events.map((event) => this.binding.codec.encodeEvent(event)),
        }),
      ),
    );
  }

  private timeoutIfAwaited(seat: Seat, decisionId: string): void {
    const state = this.state;

    if (state === undefined || !this.binding.engine.isAwaiting(state, seat, decisionId)) return;

    this.applyCommand(this.binding.engine.timeoutCommand(seat, decisionId), true);
  }

  /**
   * Decisions past their deadline: apply the default and record a timed-out wake, so a wake
   * that never reports still counts (a late report replaces the row with its real usage).
   */
  private expireDeadlines(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const game = this.game;

      if (game === undefined) return;

      const due = queryRows(
        this.ports.sql,
        DeadlineRow,
        "SELECT seat, decision_id, deadline, dispatched_at, turn, frame, round, reasons FROM decisions WHERE status = 'dispatched' AND deadline <= ?",
        this.ports.now(),
      );

      for (const row of due) {
        const seat = this.seatOf(row.seat);

        if (seat === undefined) continue;

        this.timeoutIfAwaited(seat.seat, row.decision_id);
        this.ports.sql.exec(
          "UPDATE decisions SET status = 'expired' WHERE seat = ? AND decision_id = ?",
          row.seat,
          row.decision_id,
        );
        yield* this.recordWake({
          gameId: game.gameId,
          seat: seat.seat,
          decisionId: row.decision_id,
          competitorId: seat.competitorId,
          turn: row.turn,
          kind: row.frame,
          round: row.round,
          reasons: row.reasons,
          startedAt: new Date(row.dispatched_at).toISOString(),
          latencyMs: this.ports.now() - row.dispatched_at,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0,
          toolCalls: 0,
          invalidActions: 0,
          timedOut: true,
          endReason: "noReport",
          compactions: 0,
        });
      }
    });
  }

  private recordWake(row: WakeRow): Effect.Effect<void> {
    return this.ports.db
      .recordWake(row)
      .pipe(
        Effect.catch((cause) =>
          Effect.logError(`D1 recordWake failed for ${row.gameId}/${row.seat}`, cause),
        ),
      );
  }

  // ── the settle loop ───────────────────────────────────────────────────────────────────

  /** Re-run the settle loop soon: inline if one is running, otherwise through the alarm. */
  private kick(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.purged) return Effect.void;

      if (this.settling) {
        this.dirty = true;

        return Effect.void;
      }

      return this.ports.setAlarm(this.ports.now());
    });
  }

  /**
   * Advance the game until it needs LLM input: play bot seats, dispatch wakes for undecided
   * LLM seats, finish the game when it ends. Never runs twice at once; calls that arrive
   * while it awaits mark it dirty and it loops again.
   */
  private settle(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.settling) {
        this.dirty = true;

        return;
      }

      this.settling = true;

      yield* Effect.gen({ self: this }, function* () {
        do {
          this.dirty = false;
          this.continueLater = false;
          yield* this.settleOnce();
        } while (this.dirty && !this.continueLater);

        this.flushSnapshot();
        yield* this.flushProgress();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.settling = false;
          }),
        ),
      );

      yield* this.armAlarm();
    });
  }

  private settleOnce(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      let steps = 0;

      while (this.game !== undefined && this.state !== undefined) {
        if (this.finishPending || this.status() !== "running") {
          this.flushSnapshot();
          yield* this.finish();
          yield* this.refreshStaleArchives();

          return;
        }

        const state = this.state;
        const pending = this.binding.engine.pending(state).decisions;
        const botDecision = pending.find((decision) => this.seatOf(decision.seat)?.kind === "bot");

        if (botDecision !== undefined) {
          if (steps >= (this.ports.stepsPerAlarm ?? MAX_STEPS_PER_SETTLE)) {
            this.continueLater = true;

            return;
          }

          steps += 1;

          if (!this.playBot(state, botDecision)) {
            yield* Effect.logError(
              `Default refused for ${botDecision.seat} ${botDecision.decisionId}`,
            );
            this.abortGame("engine refused the default action");
          }

          continue;
        }

        this.flushSnapshot();

        for (const decision of pending) {
          if (this.status() !== "running") break;

          yield* this.dispatch(decision);
        }

        if (this.finishPending) continue;

        return;
      }
    });
  }

  /**
   * One bot wake: its commands in order, within the per-wake limits, then the default if needed.
   * False when the engine refused the default, which leaves the decision open.
   */
  private playBot(state: S, decision: PendingDecision): boolean {
    const { engine, seats } = this.binding;
    const seat = this.seatOf(decision.seat);

    const policy =
      seat === undefined
        ? "random"
        : Match.valueTags(seat.spec, { bot: (bot) => bot.policy, llm: () => "random" as const });

    const limits = seats.limits(state);
    let used = 0;
    let invalid = 0;

    for (const command of seats.botCommands(state, decision, policy)) {
      const current = this.state;

      if (
        current === undefined ||
        !engine.isAwaiting(current, decision.seat, decision.decisionId)
      ) {
        break;
      }

      if (used >= limits.maxToolCallsPerWake || invalid >= limits.maxInvalidPerWake) break;

      used += 1;

      if (!this.applyCommand(command, false)) invalid += 1;
    }

    const after = this.state;

    if (after === undefined || !engine.isAwaiting(after, decision.seat, decision.decisionId)) {
      return true;
    }

    // A bot leaving its decision open must not stall the game: take the default.
    return this.applyCommand(engine.timeoutCommand(decision.seat, decision.decisionId), false);
  }

  private dispatch(decision: PendingDecision): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const game = this.game;
      const state = this.state;
      const seat = this.seatOf(decision.seat);

      if (game === undefined || state === undefined || seat === undefined) return;

      const known = queryFirst(
        this.ports.sql,
        StatusRow,
        "SELECT status FROM decisions WHERE seat = ? AND decision_id = ?",
        decision.seat,
        decision.decisionId,
      );

      if (known !== undefined) return;

      if (this.getMeta("budgetExhausted") === "1") {
        this.abortGame("budget exhausted");

        return;
      }

      const spec = Match.valueTags(seat.spec, { llm: (llm) => llm, bot: () => undefined });

      if (spec === undefined) return;

      const request = this.wakeRequest(game, state, decision, spec);

      this.ports.sql.transaction(() => {
        this.ports.sql.exec(
          "INSERT INTO decisions (seat, decision_id, status, deadline, dispatched_at, turn, frame, round, reasons) VALUES (?, ?, 'dispatched', ?, ?, ?, ?, ?, ?)",
          decision.seat,
          decision.decisionId,
          request.deadline,
          this.ports.now(),
          request.turn,
          request.frame,
          request.round,
          encodeReasons(request.reasons),
        );
        this.ports.sql.exec(
          "INSERT OR REPLACE INTO cursors (seat, seq) VALUES (?, ?)",
          decision.seat,
          this.lastSeq(),
        );
      });

      yield* this.ports.players
        .wake(request)
        .pipe(
          Effect.catch((cause) =>
            Effect.logError(`PlayerDO wake failed for ${game.gameId}/${decision.seat}`, cause).pipe(
              Effect.andThen(
                Effect.sync(() => this.timeoutIfAwaited(decision.seat, decision.decisionId)),
              ),
            ),
          ),
        );
    });
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
    const lines = engine.digest(this.eventsAfter(since), since, decision.seat);

    const notes = queryFirst(
      this.ports.sql,
      TextRow,
      "SELECT text FROM notes WHERE seat = ?",
      decision.seat,
    );

    const limits = seats.limits(state);

    return {
      gameId: game.gameId,
      runId: game.runId,
      seat: decision.seat,
      decisionId: decision.decisionId,
      turn: engine.pending(state).turn,
      frame: decision.frame,
      round: decision.round,
      reasons: decision.reasons,
      spec,
      listing: game.listings.find((listing) => listing.id === spec.model) ?? null,
      systemPrompt: seats.systemPrompt(state),
      message: seats.wakeMessage(state, decision, lines, notes?.text ?? ""),
      limits: {
        maxToolCallsPerWake: limits.maxToolCallsPerWake,
        maxInvalidPerWake: limits.maxInvalidPerWake,
        wakeTimeoutMs: limits.wakeTimeoutMs,
      },
      deadline: this.ports.now() + limits.wakeTimeoutMs + WAKE_GRACE_MS,
    };
  }

  private flushProgress(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const game = this.game;
      const state = this.state;

      if (game === undefined || state === undefined || this.status() !== "running") {
        return Effect.void;
      }

      const pending = this.binding.engine.pending(state);

      if (pending.turn === this.progressTurn) return Effect.void;

      this.progressTurn = pending.turn;

      return this.ports.db
        .progress(game.gameId, pending.turn, pending.round, this.iso())
        .pipe(
          Effect.catch((cause) => Effect.logError(`D1 progress failed for ${game.gameId}`, cause)),
        );
    });
  }

  private armAlarm(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.purged) return Effect.void;

      if (this.continueLater || this.dirty) return this.ports.setAlarm(this.ports.now());

      if (this.finishPending || this.staleArchives().length > 0) {
        return this.ports.setAlarm(this.ports.now() + FINISH_RETRY_MS);
      }

      const next = queryFirst(
        this.ports.sql,
        NextRow,
        "SELECT MIN(deadline) AS deadline FROM decisions WHERE status = 'dispatched'",
      );

      return this.ports.setAlarm(this.status() === "running" ? (next?.deadline ?? null) : null);
    });
  }

  // ── the end of a game ─────────────────────────────────────────────────────────────────

  private staleArchives() {
    return queryRows(this.ports.sql, SeatRow, "SELECT seat FROM stale_archives");
  }

  /**
   * Re-archive the transcripts of seats that reported after the game stopped. The mark is
   * cleared before reading, so a report landing during the upload marks the seat again.
   */
  private refreshStaleArchives(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const game = this.game;

      if (game === undefined || this.getMeta("finishedNotified") === undefined) return;

      for (const { seat } of this.staleArchives()) {
        this.ports.sql.exec("DELETE FROM stale_archives WHERE seat = ?", seat);

        yield* this.archivePut(
          archiveKeys.seat(game.gameId, seat),
          this.transcripts(seat),
          "application/x-ndjson",
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError(
              `Refreshing ${game.gameId}/${seat} transcripts failed; retrying`,
              cause,
            ).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  this.ports.sql.exec(
                    "INSERT OR IGNORE INTO stale_archives (seat) VALUES (?)",
                    seat,
                  ),
                ),
              ),
            ),
          ),
        );
      }
    });
  }

  private finish(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
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
      const records = seats.records(events);
      const finishedAt = this.iso();

      const competitorOf = (seat: Seat | null): string | null =>
        seat === null ? null : (this.seatOf(seat)?.competitorId ?? seat);

      const counterOf = (seat: Seat) => records.counters.find((counter) => counter.seat === seat);
      const standingOf = (seat: Seat) => standings.seats.find((standing) => standing.seat === seat);
      const pending = engine.pending(state);

      const delivered = yield* Effect.gen({ self: this }, function* () {
        yield* this.archivePut(
          archiveKeys.config(game.gameId),
          `${JSON.stringify(codec.encodeConfig(game.config), null, 2)}\n`,
          "application/json",
        );
        yield* this.archivePut(
          archiveKeys.events(game.gameId),
          events.map((event) => `${stringify(codec.encodeEvent(event))}\n`).join(""),
          "application/x-ndjson",
        );

        for (const seat of game.seats) {
          yield* this.archivePut(
            archiveKeys.seat(game.gameId, seat.seat),
            this.transcripts(seat.seat),
            "application/x-ndjson",
          );
        }

        yield* this.archivePut(
          archiveKeys.summary(game.gameId),
          `${JSON.stringify(
            {
              gameId: game.gameId,
              runId: game.runId,
              seed: game.config.seed,
              engine: engine.version,
              status,
              endReason: standings.endReason,
              abortReason: status === "aborted" ? (this.getMeta("abortReason") ?? null) : null,
              winner: standings.winner,
              finishedAt,
              seats: game.seats.map((seat) => ({
                seat: seat.seat,
                competitorId: seat.competitorId,
                label: seat.label,
                kind: seat.kind,
                standing: standingOf(seat.seat) ?? null,
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
          )}\n`,
          "application/json",
        );

        if (this.purged) return false;

        yield* this.ports.db.finish({
          gameId: game.gameId,
          status,
          endReason: standings.endReason ?? "aborted",
          abortReason: status === "aborted" ? (this.getMeta("abortReason") ?? null) : null,
          winnerSeat: standings.winner,
          finishedAt,
          turn: pending.turn,
          round: pending.round,
          seats: game.seats.map((seat) => ({
            seat: seat.seat,
            rank: status === "finished" ? (standingOf(seat.seat)?.rank ?? null) : null,
            netWorth: standingOf(seat.seat)?.netWorth ?? 0,
            cash: standingOf(seat.seat)?.cash ?? 0,
            bankruptAtTurn: standingOf(seat.seat)?.bankruptAtTurn ?? null,
            propertiesBought: counterOf(seat.seat)?.propertiesBought ?? 0,
            housesBuilt: counterOf(seat.seat)?.housesBuilt ?? 0,
            hotelsBuilt: counterOf(seat.seat)?.hotelsBuilt ?? 0,
            mortgages: counterOf(seat.seat)?.mortgages ?? 0,
            jailTurns: counterOf(seat.seat)?.jailTurns ?? 0,
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

        if (this.purged) return false;

        yield* this.ports.run.gameFinished(game.runId, {
          gameId: game.gameId,
          status,
          playersCount: game.seats.length,
          finishedAt,
          results: game.seats.map((seat) => ({
            seat: seat.seat,
            competitorId: seat.competitorId,
            label: seat.label,
            kind: seat.kind,
            rank: status === "finished" ? (standingOf(seat.seat)?.rank ?? null) : null,
          })),
        });

        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logError(`Finishing ${game.gameId} failed; retrying`, cause).pipe(
            Effect.as(false),
          ),
        ),
      );

      if (!delivered || this.purged) return;

      this.setMeta("finishedNotified", finishedAt);
      this.setMeta("status", status);
      this.finishPending = false;
      this.ports.broadcast(encodeSpectatorMessage(SpectatorMessage.cases.Status.make({ status })));
    });
  }

  // ── small helpers ─────────────────────────────────────────────────────────────────────

  /** R2 write that a deleted game skips (its archive is being deleted). */
  private archivePut(
    key: string,
    body: string,
    contentType: string,
  ): Effect.Effect<void, UpstreamError> {
    return Effect.suspend(() => {
      if (this.purged) return Effect.void;

      const written = Deferred.makeUnsafe<void>();

      this.archiveWrites.add(written);

      return this.ports.archive.put(key, body, contentType).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            this.archiveWrites.delete(written);

            return Deferred.succeed(written, undefined);
          }),
        ),
      );
    });
  }

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

  /** End the game as aborted, keeping the first reason for its summary. */
  private abortGame(reason: string): void {
    if (this.getMeta("abortReason") === undefined) this.setMeta("abortReason", reason);

    this.applyCommand(this.binding.engine.abortCommand(reason), true);
  }

  /**
   * The seat's current run of wakes that ended on a model error, counting this report. Kept as
   * decision ids, so a report processed twice counts once; any other ending resets it.
   */
  private modelErrorStreak(report: WakeReport): number {
    const key = `modelErrors:${report.seat}`;

    if (report.endReason !== "modelError") {
      this.ports.sql.exec("DELETE FROM meta WHERE key = ?", key);

      return 0;
    }

    const streak = new Set((this.getMeta(key) ?? "").split(",").filter((id) => id !== ""));
    streak.add(report.decisionId);
    this.setMeta(key, [...streak].join(","));

    return streak.size;
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
