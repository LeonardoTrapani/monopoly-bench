/**
 * GameDO: one per game, SQLite-backed. A thin adapter from the Cloudflare runtime to
 * `GameHost`; spectators connect with hibernatable WebSockets (server → client only).
 */
import { DurableObject } from "cloudflare:workers";
import type { Seat, SeatActivity } from "@mb/api";

import type { WorkerEnv } from "../../alchemy.run.ts";
import type { GameStart, SeatCall, SeatCallResult, WakeReport } from "../contracts.ts";
import { finishGame, gameProgress, markGameRunning, recordWake } from "../db/writes.ts";
import type { Command, GameEvent, GameState } from "@mb/engine";

import { engineBinding } from "../game/engine-binding.ts";
import { GameHost } from "../game/game-host.ts";
import { durableAlarm, durableSql, logError, runD1 } from "./runtime.ts";

export class GameDO extends DurableObject<WorkerEnv> {
  private readonly host: GameHost<GameState, GameEvent, Command>;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.host = new GameHost(
      {
        sql: durableSql(ctx.storage),
        db: {
          markRunning: (gameId, at) => runD1(env.DB, markGameRunning(gameId, at)),
          progress: (gameId, turn, round, at) =>
            runD1(env.DB, gameProgress(gameId, turn, round, at)),
          recordWake: (row) => runD1(env.DB, recordWake(row)),
          finish: (game) => runD1(env.DB, finishGame(game)),
        },
        archive: {
          put: async (key, body, contentType) => {
            await env.ARCHIVE.put(key, body, { httpMetadata: { contentType } });
          },
        },
        players: {
          wake: (request) =>
            env.PLAYERS.getByName(`${request.gameId}:${request.seat}`).wake(request),
        },
        run: {
          charge: (runId, gameId, key, costUsd) =>
            env.RUNS.getByName(runId).charge(gameId, key, costUsd),
          gameFinished: (runId, outcome) => env.RUNS.getByName(runId).gameFinished(outcome),
        },
        broadcast: (message) => {
          for (const socket of ctx.getWebSockets()) {
            try {
              socket.send(message);
            } catch (cause) {
              logError("spectator send failed", cause);
            }
          }
        },
        setAlarm: durableAlarm(ctx.storage),
        now: Date.now,
        log: logError,
      },
      engineBinding,
    );
  }

  start(input: GameStart): Promise<void> {
    return this.host.start(input);
  }

  submit(call: SeatCall): Promise<SeatCallResult> {
    return this.host.submit(call);
  }

  done(call: SeatCall): Promise<SeatCallResult> {
    return this.host.done(call);
  }

  inspect(call: SeatCall): Promise<SeatCallResult> {
    return this.host.inspect(call);
  }

  wakeFinished(report: WakeReport): Promise<void> {
    return this.host.wakeFinished(report);
  }

  activity(activity: SeatActivity): void {
    this.host.activity(activity);
  }

  abort(reason: string): Promise<void> {
    return this.host.abort(reason);
  }

  budgetExhausted(): Promise<void> {
    return this.host.budgetExhausted();
  }

  events(since: number): string {
    return this.host.eventsSince(since);
  }

  transcripts(seat: Seat | null): string {
    return this.host.transcripts(seat);
  }

  config(): string | null {
    return this.host.config();
  }

  override alarm(): Promise<void> {
    return this.host.alarm();
  }

  /** Spectator WebSocket upgrade, forwarded by the Worker from `GET /api/games/:id/ws`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());

    if (client === undefined || server === undefined)
      return new Response("WebSocket failed", { status: 500 });

    // The Worker forwards `/api/games/<id>/ws`; the id names a game that has not started yet.
    const gameId = decodeURIComponent(new URL(request.url).pathname.split("/")[3] ?? "");

    this.ctx.acceptWebSocket(server);
    server.send(this.host.helloMessage(gameId));

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Spectators only listen; anything they send is ignored. */
  override webSocketMessage(): void {}

  override webSocketClose(socket: WebSocket, code: number): void {
    socket.close(code === 1005 ? 1000 : code, "closing");
  }
}
