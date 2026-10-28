import type { RunDetail, RunSummary } from "@mb/api";
import { Option } from "effect";
import * as Scene from "foldkit/scene";
import { describe, it } from "vite-plus/test";

import { CancelAuth } from "../api/api.ts";
import {
  CancelRun,
  DetailAsyncData,
  Message,
  init,
  update,
  view,
  type Credentials,
  type Model,
} from "./run.ts";

const run = (funding: RunSummary["funding"]): RunSummary => ({
  id: "run-1",
  funding,
  name: "Evening league",
  createdAt: "2026-10-28T09:00:00.000Z",
  status: "running",
  playersCount: 4,
  seats: [],
  gamesTotal: 4,
  gamesFinished: 1,
  gamesRunning: 2,
  spentUsd: 3.2,
  budgetUsd: 50,
});

const loaded = (funding: RunSummary["funding"]): Model => {
  const detail: RunDetail = { run: run(funding), games: [] };

  return { ...init("run-1").model, detail: DetailAsyncData.Success({ data: detail }) };
};

const noCredentials: Credentials = { runToken: Option.none(), apiKey: "" };

const sceneFor = (credentials: Credentials) => ({
  update: (model: Model, message: Message) => update(model, message, credentials),
  view: Scene.withViewInputs(view, { credentials })(),
});

describe("run page", () => {
  it("says who pays", () => {
    Scene.scene(
      sceneFor(noCredentials),
      Scene.given(loaded("ownKey")),
      Scene.expect(Scene.text("Paid with own key")).toExist(),
      Scene.expect(Scene.text("Paid with the creator's own OpenRouter key.")).toExist(),
    );

    Scene.scene(
      sceneFor(noCredentials),
      Scene.given(loaded("server")),
      Scene.expect(Scene.text("Server credit")).toExist(),
    );
  });

  it("an own-key run started elsewhere cannot be cancelled from this browser", () => {
    Scene.scene(
      sceneFor(noCredentials),
      Scene.given(loaded("ownKey")),
      Scene.expect(Scene.role("button", { name: "Cancel run" })).not.toExist(),
      Scene.expect(Scene.text("Only the browser that started this run can cancel it.")).toExist(),
    );
  });

  it("the browser that started an own-key run cancels it with its token", () => {
    Scene.scene(
      sceneFor({ runToken: Option.some("tok-1"), apiKey: "" }),
      Scene.given(loaded("ownKey")),
      Scene.expect(Scene.text("You started this run: this browser can cancel it.")).toExist(),
      Scene.click(Scene.role("button", { name: "Cancel run" })),
      Scene.Command.expectHas(
        CancelRun({ runId: "run-1", auth: CancelAuth.RunToken({ token: "tok-1" }) }),
      ),
      Scene.Command.resolve(
        CancelRun,
        Message.SucceededCancelRun({ run: { ...run("ownKey"), status: "cancelled" } }),
      ),
      Scene.expect(Scene.role("button", { name: "Cancel run" })).not.toExist(),
    );
  });
});
