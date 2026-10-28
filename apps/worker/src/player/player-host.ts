/**
 * PlayerDO logic (SPEC.md §7.1): runs the wakes of one LLM seat of one game.
 *
 * Alarm-driven: `wake()` only stores the request and arms the alarm, so GameDO's call returns
 * at once and no request stays open while the model thinks. The alarm runs the Pi agent
 * (`@mb/agent` `runWake`); its tools call GameDO (`submit`, `done`, `inspect`) and its activity
 * streams to GameDO for spectators. The seat's conversation lasts the whole game (SPEC §6.2):
 * one SQLite row per message, appended after every wake and rewritten only by a compaction.
 *
 * The OpenRouter key of a wake comes from `models` (the run's own key or the server's) and lives
 * in memory for that wake only; it is scrubbed from what the wake reports.
 *
 * A wake cut off by an eviction is never re-run (it would pay the model twice and may be past
 * its deadline): the next alarm reports it as interrupted and GameDO applies the default.
 */
import {
  type Api,
  type Conversation,
  decodeAgentMessage,
  DEFAULT_MEMORY_LIMITS,
  encodeAgentMessage,
  type MemoryLimits,
  type Model,
  runWake,
  type StreamFn,
  type ToolExecutor,
  transcriptText,
  type WakeEndReason,
} from "@mb/agent";
import type { SeatActivity, WakeTranscript } from "@mb/api";
import { Schema } from "effect";

import {
  type ModelCredentials,
  type SeatCall,
  type SeatCallResult,
  WakeReport,
  WakeRequest,
} from "../contracts.ts";
import { jsonColumn, queryRows, type SqlPort } from "../sql.ts";

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
  /** Resolved before every wake (an own-key run's key is read from its RunDO then). */
  readonly models: (request: WakeRequest) => Promise<ModelAccess>;
  readonly setAlarm: (at: number | null) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string, cause?: unknown) => void;
  /** Conversation budget (default `DEFAULT_MEMORY_LIMITS`). */
  readonly memory?: MemoryLimits;
}

/**
 * The key a wake calls OpenRouter with: the server's for a server-funded run, the run's own key
 * for an own-key run, and none when the run is no longer active (`credentials` null) or deleted
 * its key: the wake then fails fast instead of being billed to the server.
 */
export const openRouterKeyFor = (
  credentials: ModelCredentials | null,
  serverKey: string,
): string | undefined => {
  if (credentials === null) return undefined;

  if (credentials.funding === "ownKey") return credentials.openRouterKey ?? undefined;

  return serverKey.length === 0 ? undefined : serverKey;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wakes (
  decision_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  request_json TEXT NOT NULL, report_json TEXT
);
CREATE TABLE IF NOT EXISTS conversation (
  idx INTEGER PRIMARY KEY, wake_start INTEGER NOT NULL, json TEXT NOT NULL
);
DROP TABLE IF EXISTS session;
`;

const WakeRow = Schema.Struct({
  decision_id: Schema.String,
  status: Schema.String,
  request_json: Schema.String,
  report_json: Schema.NullOr(Schema.String),
});

const MessageRow = Schema.Struct({ wake_start: Schema.Int, json: Schema.String });

const decodeRequest = jsonColumn(WakeRequest);

/** Tool arguments come from the model as JSON and were validated against the tool schema. */
const toJson = Schema.decodeUnknownSync(Schema.Json);

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(WakeRequest));

const decodeReport = jsonColumn(WakeReport);

const encodeReport = Schema.encodeSync(Schema.fromJsonString(WakeReport));

const emptyUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };

const REDACTED = "[redacted key]";

/** `text` without any occurrence of `secret`. */
const scrub = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length === 0 ? text : text.replaceAll(secret, REDACTED);

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

export class PlayerHost {
  /** The game was deleted: a wake still in flight must not write anything more. */
  private purged = false;

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
        await this.report(request, this.emptyTranscript(request), 0, "interrupted", 0);
        continue;
      }

      this.setStatus(request.decisionId, "running");

      if (this.ports.now() > request.deadline) {
        await this.report(request, this.emptyTranscript(request), 0, "expired", 0);
        continue;
      }

      await this.run(request);
    }
  }

  /** RunDO → PlayerDO when the run is deleted: drop every wake and the conversation. */
  async purge(): Promise<void> {
    this.purged = true;
    this.ports.sql.transaction(() => {
      this.ports.sql.exec("DELETE FROM wakes");
      this.ports.sql.exec("DELETE FROM conversation");
    });
    await this.ports.setAlarm(null);
  }

  /** The seat's conversation so far, from its rows. */
  conversation(): Conversation {
    const rows = queryRows(
      this.ports.sql,
      MessageRow,
      "SELECT wake_start, json FROM conversation ORDER BY idx",
    );

    return {
      messages: rows.map((row) => decodeAgentMessage(row.json)),
      wakeStarts: rows.flatMap((row, index) => (row.wake_start === 1 ? [index] : [])),
    };
  }

  /**
   * Appends the wake's new messages; a compaction rewrites the conversation. Provider errors
   * are kept in the conversation, so the wake's key is scrubbed from them as well.
   */
  private saveConversation(
    before: Conversation,
    after: Conversation,
    rewritten: boolean,
    apiKey: string | undefined,
  ): void {
    const starts = new Set(after.wakeStarts);
    const from = rewritten ? 0 : before.messages.length;

    this.ports.sql.transaction(() => {
      if (rewritten) this.ports.sql.exec("DELETE FROM conversation");

      after.messages.slice(from).forEach((message, offset) => {
        const index = from + offset;

        this.ports.sql.exec(
          "INSERT INTO conversation (idx, wake_start, json) VALUES (?, ?, ?)",
          index,
          starts.has(index) ? 1 : 0,
          scrub(encodeAgentMessage(message), apiKey),
        );
      });
    });
  }

  private async run(request: WakeRequest): Promise<void> {
    const startedAt = new Date(this.ports.now()).toISOString();
    let apiKey: string | undefined;

    try {
      const access = await this.ports.models(request);
      const before = this.conversation();

      apiKey = access.apiKey;

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
        conversation: before,
        message: request.message,
        executor: this.executor(request),
        limits: request.limits,
        memory: this.ports.memory ?? DEFAULT_MEMORY_LIMITS,
        onActivity: (activity) =>
          this.ports.game.activity(request.gameId, activity).catch((cause: unknown) => {
            this.ports.log("activity relay failed", scrub(describeCause(cause), apiKey));
          }),
        sessionId: `${request.gameId}:${request.seat}`,
        signal: undefined,
        now: this.ports.now,
      });

      if (this.purged) return;

      this.saveConversation(
        before,
        result.conversation,
        result.compaction?.compacted === true,
        apiKey,
      );

      const transcript: WakeTranscript = {
        ...this.emptyTranscript(request),
        startedAt,
        finishedAt: new Date(this.ports.now()).toISOString(),
        reasoning: result.reasoning,
        text: scrub(transcriptText(result), apiKey),
        toolCalls: result.toolCalls,
        usage: result.usage,
        invalidActions: result.invalidActions,
        timedOut: result.timedOut,
      };

      await this.report(
        request,
        transcript,
        result.latencyMs,
        result.endReason,
        result.compaction?.compacted === true ? 1 : 0,
      );
    } catch (cause) {
      this.ports.log(
        `wake ${request.gameId}/${request.seat}/${request.decisionId} failed`,
        scrub(describeCause(cause), apiKey),
      );
      await this.report(request, { ...this.emptyTranscript(request), startedAt }, 0, "failed", 0);
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
    compactions: number,
  ): Promise<void> {
    if (this.purged) return;

    const report: WakeReport = {
      gameId: request.gameId,
      seat: request.seat,
      decisionId: request.decisionId,
      transcript,
      latencyMs,
      endReason,
      compactions,
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
