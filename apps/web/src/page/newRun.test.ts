import { BotSeat, LlmSeat, defaultModelCatalog, type RunSummary } from "@mb/api";
import { Result } from "effect";
import * as Scene from "foldkit/scene";
import { Command, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vite-plus/test";

import {
  SeatDraft,
  defaultForm,
  errorsFor,
  gamesCount,
  validateRunForm,
  type RunForm,
} from "../domain/runForm.ts";
import {
  CreateRun,
  Message,
  OutMessage,
  SaveApiKey,
  Submission,
  init,
  update,
  view,
  type Model,
} from "./newRun.ts";

const validForm: RunForm = {
  ...defaultForm(defaultModelCatalog, "secret"),
  name: "Smoke test",
  seats: [
    SeatDraft.Llm({
      model: "anthropic/claude-sonnet-5.5",
      isCustom: false,
      label: "Claude Sonnet 5.5",
      reasoning: "high",
    }),
    SeatDraft.Bot({ policy: "random" }),
  ],
  seeds: "4",
  maxRounds: "80",
  concurrency: "",
  budgetUsd: "12.5",
};

const editing = (form: RunForm): Model => ({
  ...init(form.apiKey).model,
  form,
});

const createdRun: RunSummary = {
  id: "run-42",
  name: "Smoke test",
  createdAt: "2026-10-28T09:00:00.000Z",
  status: "queued",
  playersCount: 2,
  seats: [],
  gamesTotal: 8,
  gamesFinished: 0,
  gamesRunning: 0,
  spentUsd: 0,
  budgetUsd: 12.5,
};

describe("run form validation", () => {
  it("turns a valid form into a RunConfig", () => {
    const result = validateRunForm(validForm);

    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toEqual({
      name: "Smoke test",
      players: [
        LlmSeat.make({
          model: "anthropic/claude-sonnet-5.5",
          label: "Claude Sonnet 5.5",
          reasoning: "high",
        }),
        BotSeat.make({ policy: "random" }),
      ],
      seeds: 4,
      maxRounds: 80,
      tableFrequency: "everyTurn",
      budgetUsd: 12.5,
    });
  });

  it("counts games as seeds × seats", () => {
    expect(gamesCount(validForm)).toBe(8);
  });

  it("reports every invalid field", () => {
    const result = validateRunForm({
      ...validForm,
      seats: [
        SeatDraft.Llm({ model: "not a model id", isCustom: true, label: "", reasoning: "off" }),
      ],
      seeds: "0",
      maxRounds: "abc",
      concurrency: "40",
      budgetUsd: "-3",
      apiKey: " ",
    });

    const errors = Result.match(result, { onFailure: (failures) => failures, onSuccess: () => [] });

    expect(errorsFor(errors, "seats")).toHaveLength(1);
    expect(errorsFor(errors, "seat-0")).toHaveLength(2);
    expect(errorsFor(errors, "seeds")).toHaveLength(1);
    expect(errorsFor(errors, "maxRounds")).toHaveLength(1);
    expect(errorsFor(errors, "concurrency")).toHaveLength(1);
    expect(errorsFor(errors, "budgetUsd")).toHaveLength(1);
    expect(errorsFor(errors, "apiKey")).toHaveLength(1);
  });
});

describe("start-a-run update", () => {
  it("an invalid submit shows errors and sends nothing", () => {
    story(
      update,
      given(editing({ ...validForm, apiKey: "" })),
      message(Message.SubmittedForm()),
      Command.expectNone(),
      model((next) => expect(next.isShowingErrors).toBe(true)),
    );
  });

  it("a valid submit creates the run, saves the key and reports the new run", () => {
    story(
      update,
      given(editing(validForm)),
      message(Message.SubmittedForm()),
      model((next) => expect(next.submission).toEqual(Submission.Submitting())),
      expectOutMessage(OutMessage.SavedApiKey({ apiKey: "secret" })),
      Command.expectHas(SaveApiKey({ apiKey: "secret" })),
      Command.resolve(SaveApiKey, Message.CompletedSaveApiKey()),
      Command.resolve(CreateRun, Message.SucceededCreateRun({ run: createdRun })),
      expectOutMessage(OutMessage.CreatedRun({ runId: "run-42" })),
    );
  });

  it("a rejected key is shown as a failure", () => {
    story(
      update,
      given(editing(validForm)),
      message(Message.SubmittedForm()),
      Command.resolveAll(
        [SaveApiKey, Message.CompletedSaveApiKey()],
        [CreateRun, Message.FailedCreateRun({ error: "Missing or invalid API key (HTTP 401)" })],
      ),
      model((next) =>
        expect(next.submission).toEqual(
          Submission.Failed({ error: "Missing or invalid API key (HTTP 401)" }),
        ),
      ),
    );
  });

  it("seats can be added up to six and removed down to two", () => {
    story(
      update,
      given(editing(validForm)),
      message(Message.ClickedRemoveSeat({ index: 0 })),
      model((next) => expect(next.form.seats).toHaveLength(2)),
      message(Message.ClickedAddBotSeat()),
      message(Message.ClickedAddLlmSeat()),
      message(Message.ClickedAddLlmSeat()),
      message(Message.ClickedAddLlmSeat()),
      message(Message.ClickedAddLlmSeat()),
      model((next) => expect(next.form.seats).toHaveLength(6)),
    );
  });

  it("choosing a custom model switches the seat to a free-form id", () => {
    story(
      update,
      given(editing(validForm)),
      message(Message.SelectedSeatModel({ index: 0, value: "__custom__" })),
      message(Message.UpdatedSeatCustomModel({ index: 0, value: "acme/frontier-1" })),
      model((next) =>
        expect(next.form.seats[0]).toEqual(
          SeatDraft.Llm({ model: "acme/frontier-1", isCustom: true, label: "", reasoning: "high" }),
        ),
      ),
    );
  });
});

describe("start-a-run view", () => {
  it("shows field errors after a failed submit", () => {
    Scene.scene(
      { update, view },
      Scene.given(editing({ ...validForm, seeds: "0", apiKey: "" })),
      Scene.submit(Scene.role("form")),
      Scene.expect(Scene.text("Seeds must be a whole number from 1 to 200.")).toExist(),
      Scene.expect(Scene.text("Starting a run needs the bench API key.")).toExist(),
    );
  });

  it("explains the game count", () => {
    Scene.scene(
      { update, view },
      Scene.given(editing(validForm)),
      Scene.expect(Scene.text("8 games = seeds × 2 seats.")).toExist(),
    );
  });
});
