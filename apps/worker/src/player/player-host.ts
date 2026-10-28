/**
 * PlayerDO logic (SPEC.md §7.1): runs the wakes of one LLM seat of one game.
 *
 * Alarm-driven: `wake()` only stores the request and arms the alarm, so GameDO's call returns
 * at once and no request stays open while the model thinks. The alarm runs the Pi agent
 * (`@mb/agent` `runWake`); its tools call GameDO (`submit`, `done`, `inspect`) and its activity
 * streams to GameDO for spectators. The session conversation is kept in SQLite between the
 * rounds of one session and dropped when a new session starts.
 *
 * A wake cut off by an eviction is never re-run (it would pay the model twice and may be past
 * its deadline): the next alarm reports it as interrupted and GameDO applies the default.
 */
import {
  type AgentMessage,
  type Api,
  type Model,
  type StreamFn,
  decodeSession,
  encodeSession,
  runWake,
  type ToolExecutor,
  type WakeEndReason,
} from "@mb/agent";
import type { SeatActivity, WakeTranscript } from "@mb/api";
import { Schema } from "effect";

import { type SeatCall, type SeatCallResult, WakeReport, WakeRequest } from "../contracts.ts";
import { jsonColumn, queryFirst, queryRows, type SqlPort } from "../sql.ts";

export interface GameLinkPort {
  readonly submit: (call: SeatCall) => Promise<SeatCallResult>;
  readonly done: (call: SeatCall) => Promise<SeatCallResult>;
  readonly inspect: (call: SeatCall) => Promise<SeatCallResult>;
  readonly activity: (gameId: string, activity: SeatActivity) => Promise<void>;
  readonly wakeFinished: (report: WakeReport) => Promise<void>;
}

/** How a wake reaches its model: OpenRouter through pi-ai in production, faux in tests. */
export interface ModelAccess {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly apiKey: string | undefined;
}

export interface PlayerHostPorts {
  readonly sql: SqlPort;
  readonly game: GameLinkPort;
  readonly models: (request: WakeRequest) => ModelAccess;
  readonly setAlarm: (at: number | null) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string, cause?: unknown) => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wakes (
  decision_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  request_json TEXT NOT NULL, report_json TEXT
);
CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY CHECK (id = 1), session_key TEXT NOT NULL, messages TEXT NOT NULL
);
`;

const WakeRow = Schema.Struct({
  decision_id: Schema.String,
  status: Schema.String,
  request_json: Schema.String,
  report_json: Schema.NullOr(Schema.String),
});

const SessionRow = Schema.Struct({ session_key: Schema.String, messages: Schema.String });

const decodeRequest = jsonColumn(WakeRequest);

/** Tool arguments come from the model as JSON and were validated against the tool schema. */
const toJson = Schema.decodeUnknownSync(Schema.Json);

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(WakeRequest));

const decodeReport = jsonColumn(WakeReport);

const encodeReport = Schema.encodeSync(Schema.fromJsonString(WakeReport));

const emptyUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };

export class PlayerHost {
  constructor(private readonly ports: PlayerHostPorts) {
    ports.sql.exec(SCHEMA);
  }

  /** GameDO → PlayerDO. Stores the request and returns; the alarm runs it. Idempotent. */
  async wake(request: WakeRequest): Promise<void> {
    this.ports.sql.exec(
      "INSERT OR IGNORE INTO wakes (decision_id, status, created_at, request_json) VALUES (?, 'queued', ?, ?)",
      request.decisionId,
      this.ports.now(),
      encodeRequest(request),
    );
    await this.ports.setAlarm(this.ports.now());
  }

  async alarm(): Promise<void> {
    const rows = queryRows(
      this.ports.sql,
      WakeRow,
      "SELECT decision_id, status, request_json, report_json FROM wakes WHERE status IN ('queued', 'running', 'reporting') ORDER BY created_at",
    );

    for (const row of rows) {
      const request = decodeRequest(row.request_json);

      if (row.report_json !== null) {
        await this.send(decodeReport(row.report_json));
        continue;
      }

      if (row.status === "running") {
        await this.report(request, this.emptyTranscript(request), 0, "interrupted");
        continue;
      }

      this.setStatus(request.decisionId, "running");

      if (this.ports.now() > request.deadline) {
        await this.report(request, this.emptyTranscript(request), 0, "expired");
        continue;
      }

      await this.run(request);
    }
  }

  private async run(request: WakeRequest): Promise<void> {
    const startedAt = new Date(this.ports.now()).toISOString();

    const session = queryFirst(
      this.ports.sql,
      SessionRow,
      "SELECT session_key, messages FROM session WHERE id = 1",
    );

    const history: ReadonlyArray<AgentMessage> =
      session !== undefined && session.session_key === request.sessionKey
        ? decodeSession(session.messages)
        : [];

    try {
      const access = this.ports.models(request);

      const result = await runWake({
        identity: {
          seat: request.seat,
          decisionId: request.decisionId,
          frame: request.frame,
          round: request.round,
          turn: request.turn,
          reasons: request.reasons,
        },
        model: access.model,
        streamFn: access.streamFn,
        apiKey: access.apiKey,
        reasoning: request.spec.reasoning,
        maxOutputTokens: request.spec.maxOutputTokens,
        systemPrompt: request.systemPrompt,
        history,
        message: request.message,
        executor: this.executor(request),
        limits: request.limits,
        onActivity: (activity) =>
          this.ports.game.activity(request.gameId, activity).catch((cause: unknown) => {
            this.ports.log("activity relay failed", cause);
          }),
        sessionId: `${request.gameId}:${request.seat}`,
        signal: undefined,
        now: this.ports.now,
      });

      this.ports.sql.exec(
        "INSERT OR REPLACE INTO session (id, session_key, messages) VALUES (1, ?, ?)",
        request.sessionKey,
        encodeSession(result.messages),
      );

      const transcript: WakeTranscript = {
        ...this.emptyTranscript(request),
        startedAt,
        finishedAt: new Date(this.ports.now()).toISOString(),
        reasoning: result.reasoning,
        text:
          result.errorMessage === null
            ? result.text
            : `${result.text}\n[model error] ${result.errorMessage}`.trim(),
        toolCalls: result.toolCalls,
        usage: result.usage,
        invalidActions: result.invalidActions,
        timedOut: result.timedOut,
      };

      await this.report(request, transcript, result.latencyMs, result.endReason);
    } catch (cause) {
      this.ports.log(`wake ${request.gameId}/${request.seat}/${request.decisionId} failed`, cause);
      await this.report(request, { ...this.emptyTranscript(request), startedAt }, 0, "failed");
    }
  }

  private executor(request: WakeRequest): ToolExecutor {
    return async (name, args, callId) => {
      const call: SeatCall = {
        gameId: request.gameId,
        seat: request.seat,
        decisionId: request.decisionId,
        callId,
        tool: name,
        args: toJson(args),
      };

      if (name === "done") return this.ports.game.done(call);

      if (name === "inspect") return this.ports.game.inspect(call);

      return this.ports.game.submit(call);
    };
  }

  /** Stores the report before sending it, so a failed delivery is retried with the same data. */
  private async report(
    request: WakeRequest,
    transcript: WakeTranscript,
    latencyMs: number,
    endReason: WakeEndReason | "interrupted" | "expired" | "failed",
  ): Promise<void> {
    const report: WakeReport = {
      gameId: request.gameId,
      seat: request.seat,
      decisionId: request.decisionId,
      transcript,
      latencyMs,
      endReason,
    };

    this.ports.sql.exec(
      "UPDATE wakes SET status = 'reporting', report_json = ? WHERE decision_id = ?",
      encodeReport(report),
      request.decisionId,
    );
    await this.send(report);
  }

  private async send(report: WakeReport): Promise<void> {
    try {
      await this.ports.game.wakeFinished(report);
      this.setStatus(report.decisionId, "done");
    } catch (cause) {
      // The next alarm sends it again; GameDO ignores duplicates.
      this.ports.log(`wakeFinished failed for ${report.gameId}/${report.seat}`, cause);
      await this.ports.setAlarm(this.ports.now() + 10_000);
    }
  }

  private emptyTranscript(request: WakeRequest): WakeTranscript {
    return {
      gameId: request.gameId,
      seat: request.seat,
      decisionId: request.decisionId,
      turn: request.turn,
      frame: request.frame,
      round: request.round,
      reasons: request.reasons,
      startedAt: new Date(this.ports.now()).toISOString(),
      finishedAt: new Date(this.ports.now()).toISOString(),
      prompt: request.message,
      reasoning: "",
      text: "",
      toolCalls: [],
      usage: emptyUsage,
      invalidActions: 0,
      timedOut: false,
    };
  }

  private setStatus(decisionId: string, status: "running" | "done"): void {
    this.ports.sql.exec("UPDATE wakes SET status = ? WHERE decision_id = ?", status, decisionId);
  }
}
