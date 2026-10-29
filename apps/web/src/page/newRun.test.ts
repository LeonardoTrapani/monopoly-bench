import { LlmSeat, estimateSeatCostUsd, type ModelCatalogEntry, type RunSummary } from "@mb/api";
import { Combobox } from "@foldkit/ui";
import { Option, Result } from "effect";
import * as Scene from "foldkit/scene";
import { Command, expectOutMessage, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vite-plus/test";

import { RunPayment } from "../api/api.ts";
import { usd } from "../domain/format.ts";
import {
  defaultForm,
  errorsFor,
  estimateRunCost,
  gamesCount,
  orderCatalog,
  searchCatalog,
  validateRunForm,
  withCatalog,
  type RunForm,
} from "../domain/runForm.ts";
import { catalog } from "../testing/fixtures.ts";
import {
  CatalogAsyncData,
  CreateRun,
  FetchCatalog,
  Message,
  OutMessage,
  SaveApiKey,
  Submission,
  init,
  update,
  view,
  type Model,
} from "./newRun.ts";

const models = Option.some(catalog.models);

const validForm: RunForm = {
  ...defaultForm(""),
  name: "Smoke test",
  seats: [
    { model: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5", reasoning: "high" },
    { model: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", reasoning: "off" },
  ],
  seeds: "4",
  maxRounds: "80",
  budgetUsd: "12.5",
  funding: "ownKey",
  openRouterKey: "sk-or-test",
};

/** The page with `form` filled in and the catalog loaded. */
const loaded = (form: RunForm): Model => {
  const fresh = init(form.apiKey).model;

  return {
    ...fresh,
    form,
    catalog: CatalogAsyncData.Success({ data: catalog }),
    pickers: fresh.pickers.slice(0, form.seats.length),
  };
};

const createdRun: RunSummary = {
  id: "run-42",
  funding: "ownKey",
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

const failures = (form: RunForm) =>
  Result.match(validateRunForm(form, models), {
    onFailure: (errors) => errors,
    onSuccess: () => [],
  });

describe("run form validation", () => {
  it("turns a valid form into a RunConfig paid with the creator's key", () => {
    const result = validateRunForm(validForm, models);

    expect(Result.getOrThrow(result)).toEqual({
      config: {
        name: "Smoke test",
        players: [
          LlmSeat.make({
            model: "anthropic/claude-sonnet-5.5",
            label: "Claude Sonnet 5.5",
            reasoning: "high",
          }),
          LlmSeat.make({ model: "deepseek/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro" }),
        ],
        seeds: 4,
        maxRounds: 80,
        tableFrequency: "everyTurn",
        budgetUsd: 12.5,
      },
      payment: RunPayment.OwnKey({ openRouterKey: "sk-or-test" }),
    });
  });

  it("server-paid runs need the bench key and send it as the payment", () => {
    const server: RunForm = { ...validForm, funding: "server", apiKey: "" };

    expect(errorsFor(failures(server), "apiKey")).toEqual([
      "Server-paid runs need the bench API key.",
    ]);
    expect(
      Result.map(validateRunForm({ ...server, apiKey: "bench" }, models), (valid) => valid.payment),
    ).toEqual(Result.succeed(RunPayment.BenchKey({ apiKey: "bench" })));
  });

  it("reports every invalid field", () => {
    const errors = failures({
      ...validForm,
      seats: [{ model: "acme/not-listed", label: "", reasoning: "off" }],
      seeds: "0",
      maxRounds: "abc",
      budgetUsd: "-3",
      openRouterKey: " ",
    });

    expect(errorsFor(errors, "seats")).toHaveLength(1);
    expect(errorsFor(errors, "seat-0")).toEqual([
      "acme/not-listed is not in the model catalog: choose another model.",
      "Give this seat a label.",
    ]);
    expect(errorsFor(errors, "seeds")).toHaveLength(1);
    expect(errorsFor(errors, "maxRounds")).toHaveLength(1);
    expect(errorsFor(errors, "budgetUsd")).toHaveLength(1);
    expect(errorsFor(errors, "openRouterKey")).toEqual(["Paste your OpenRouter API key."]);
  });

  it("without a catalog, any well-formed OpenRouter id is accepted", () => {
    const custom: RunForm = {
      ...validForm,
      seats: [
        { model: "acme/frontier-1", label: "Acme", reasoning: "off" },
        { model: "not a model id", label: "Broken", reasoning: "off" },
      ],
    };

    const errors = Result.match(validateRunForm(custom, Option.none()), {
      onFailure: (problems) => problems,
      onSuccess: () => [],
    });

    expect(errorsFor(errors, "seat-0")).toEqual([]);
    expect(errorsFor(errors, "seat-1")).toHaveLength(1);
  });

  it("counts games as seeds × seats", () => {
    expect(gamesCount(validForm)).toBe(8);
  });
});

describe("model catalog", () => {
  it("lists featured models first, in featured order, then providers alphabetically", () => {
    expect(orderCatalog(catalog.models).map((entry) => entry.model)).toEqual([
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-haiku-5.5",
      "deepseek/deepseek-v4-pro-0813",
      "acme/mystery-7b",
      "mistralai/devstral-2",
      "zeta/zeta-1",
    ]);
  });

  it("keeps each provider's models together when one slug has two provider names", () => {
    const entry = (model: string, provider: string): ModelCatalogEntry => ({
      ...catalog.models[0]!,
      model,
      label: model,
      provider,
      providerSlug: model.slice(0, model.indexOf("/")),
      featured: false,
    });

    const slugs = orderCatalog([
      entry("x-ai/grok-a", "SpaceXAI"),
      entry("together/t-1", "Together"),
      entry("x-ai/grok-b", "xAI"),
    ]).map((model) => model.providerSlug);

    // By provider name, "Together" sorts between "SpaceXAI" and "xAI" and splits x-ai in two.
    expect(slugs).toEqual(["together", "x-ai", "x-ai"]);
  });

  it("finds models by name, provider or id, word by word", () => {
    const ordered = orderCatalog(catalog.models);
    const ids = (query: string) => searchCatalog(ordered, query).map((entry) => entry.model);

    expect(ids("haiku")).toEqual(["anthropic/claude-haiku-5.5"]);
    expect(ids("ANTHROPIC")).toEqual(["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"]);
    expect(ids("mistralai/")).toEqual(["mistralai/devstral-2"]);
    expect(ids("claude 5.5 son")).toEqual(["anthropic/claude-sonnet-5.5"]);
    expect(ids("  ")).toHaveLength(catalog.models.length);
    expect(ids("nothing-like-this")).toEqual([]);
  });

  it("names the default seats and swaps ids the catalog does not list", () => {
    const seats = withCatalog(defaultForm("").seats, catalog.models);

    expect(seats.map((seat) => [seat.model, seat.label])).toEqual([
      ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5"],
      ["deepseek/deepseek-v4-pro-0813", "DeepSeek V4 Pro"],
      ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
      ["acme/mystery-7b", "Mystery 7B"],
    ]);
  });

  it("estimates a run as the sum of seat estimates × games", () => {
    const sonnet = catalog.models[3]?.estimatedSeatCostUsd ?? 0;
    const deepseek = catalog.models[2]?.estimatedSeatCostUsd ?? 0;
    const estimate = estimateRunCost(validForm, catalog.models);

    expect(sonnet).toBeCloseTo(4.99275, 5);
    expect(estimate.games).toBe(8);
    expect(estimate.perGameUsd).toBeCloseTo(sonnet + deepseek, 9);
    expect(estimate.totalUsd).toBeCloseTo((sonnet + deepseek) * 8, 9);
    expect(estimate.unpricedSeats).toBe(0);

    const withUnpriced = estimateRunCost(
      {
        ...validForm,
        seats: [...validForm.seats, { model: "acme/mystery-7b", label: "M", reasoning: "off" }],
      },
      catalog.models,
    );

    expect(withUnpriced.unpricedSeats).toBe(1);
    expect(withUnpriced.games).toBe(12);
    expect(withUnpriced.totalUsd).toBeCloseTo((sonnet + deepseek) * 12, 9);
  });

  it("uses the shared per-seat cost model", () => {
    expect(
      estimateSeatCostUsd({
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
      }),
    ).toBeCloseTo(4.99275, 5);
  });
});

describe("start-a-run update", () => {
  it("loads the catalog and names the default seats from it", () => {
    const start = init("");

    expect(start.model.form.funding).toBe("ownKey");
    expect(start.model.pickers.map((picker) => picker.id)).toEqual([
      "seat-model-1",
      "seat-model-2",
      "seat-model-3",
      "seat-model-4",
    ]);

    story(
      update,
      given(start.model),
      message(Message.SucceededFetchCatalog({ catalog })),
      model((next) => {
        expect(next.catalog._tag).toBe("Success");
        expect(next.form.seats.map((seat) => seat.label)).toEqual([
          "Claude Haiku 5.5",
          "DeepSeek V4 Pro",
          "Claude Sonnet 5.5",
          "Mystery 7B",
        ]);
      }),
    );
  });

  it("starts with server credit when the bench key is remembered", () => {
    expect(init("bench").model.form.funding).toBe("server");
  });

  it("an invalid submit shows errors and sends nothing", () => {
    story(
      update,
      given(loaded({ ...validForm, openRouterKey: "" })),
      message(Message.SubmittedForm()),
      Command.expectNone(),
      model((next) => expect(next.isShowingErrors).toBe(true)),
    );
  });

  it("an own-key run sends the key once, never saves it, and keeps the cancel token", () => {
    story(
      update,
      given(loaded(validForm)),
      message(Message.SubmittedForm()),
      model((next) => expect(next.submission).toEqual(Submission.Submitting())),
      Command.expectExact(
        CreateRun({
          config: Result.getOrThrow(validateRunForm(validForm, models)).config,
          payment: RunPayment.OwnKey({ openRouterKey: "sk-or-test" }),
        }),
      ),
      Command.resolve(
        CreateRun,
        Message.SucceededCreateRun({ response: { run: createdRun, cancelToken: "tok-42" } }),
      ),
      model((next) => expect(next.form.openRouterKey).toBe("")),
      expectOutMessage(
        OutMessage.CreatedRun({ runId: "run-42", cancelToken: Option.some("tok-42") }),
      ),
    );
  });

  it("a server-paid run remembers the bench key", () => {
    const server: RunForm = { ...validForm, funding: "server", apiKey: "secret" };

    story(
      update,
      given(loaded(server)),
      message(Message.SubmittedForm()),
      expectOutMessage(OutMessage.SavedApiKey({ apiKey: "secret" })),
      Command.expectHas(
        CreateRun({
          config: Result.getOrThrow(validateRunForm(server, models)).config,
          payment: RunPayment.BenchKey({ apiKey: "secret" }),
        }),
        SaveApiKey({ apiKey: "secret" }),
      ),
      Command.resolve(SaveApiKey, Message.CompletedSaveApiKey()),
      Command.resolve(
        CreateRun,
        Message.SucceededCreateRun({
          response: { run: { ...createdRun, funding: "server" }, cancelToken: null },
        }),
      ),
      expectOutMessage(OutMessage.CreatedRun({ runId: "run-42", cancelToken: Option.none() })),
    );
  });

  it("a rejected key is shown as a failure", () => {
    story(
      update,
      given(loaded(validForm)),
      message(Message.SubmittedForm()),
      Command.resolve(
        CreateRun,
        Message.FailedCreateRun({ error: "OpenRouter rejected this API key (HTTP 401)" }),
      ),
      model((next) =>
        expect(next.submission).toEqual(
          Submission.Failed({ error: "OpenRouter rejected this API key (HTTP 401)" }),
        ),
      ),
    );
  });

  it("picking a model in a seat's search seats it with its catalog label", () => {
    story(
      update,
      given(loaded(validForm)),
      message(
        Message.GotSeatPickerMessage({
          seatId: "seat-model-1",
          message: Combobox.Message.SelectedItem({
            item: "mistralai/devstral-2",
            displayText: "",
            wasSelected: false,
          }),
        }),
      ),
      model((next) => {
        expect(next.form.seats[0]).toEqual({
          model: "mistralai/devstral-2",
          label: "Devstral 2",
          reasoning: "off",
        });
        expect(next.form.seats[1]).toEqual(validForm.seats[1]);
      }),
      Command.resolve(Combobox.FocusInput, Combobox.Message.CompletedFocusInput()),
    );
  });

  it("seats can be added up to six and removed down to two, each with its own search", () => {
    story(
      update,
      given(loaded(validForm)),
      message(Message.ClickedAddSeat()),
      message(Message.ClickedAddSeat()),
      message(Message.ClickedAddSeat()),
      message(Message.ClickedAddSeat()),
      message(Message.ClickedAddSeat()),
      model((next) => {
        expect(next.form.seats).toHaveLength(6);
        expect(next.pickers).toHaveLength(6);
        expect(new Set(next.form.seats.map((seat) => seat.model)).size).toBe(6);
      }),
      message(Message.ClickedRemoveSeat({ seatId: "seat-model-1" })),
      model((next) => {
        expect(next.form.seats).toHaveLength(5);
        expect(next.pickers.map((picker) => picker.id)).not.toContain("seat-model-1");
        expect(next.form.seats[0]).toEqual(validForm.seats[1]);
      }),
      message(Message.ClickedRemoveSeat({ seatId: "seat-model-2" })),
      message(Message.ClickedRemoveSeat({ seatId: "seat-model-5" })),
      message(Message.ClickedRemoveSeat({ seatId: "seat-model-6" })),
      message(Message.ClickedRemoveSeat({ seatId: "seat-model-7" })),
      model((next) => expect(next.form.seats).toHaveLength(2)),
    );
  });

  it("when the catalog fails, seats take typed OpenRouter ids", () => {
    story(
      update,
      given(init("").model),
      message(Message.FailedFetchCatalog({ error: "Network error" })),
      message(Message.UpdatedSeatModelId({ seatId: "seat-model-1", value: "acme/frontier-1" })),
      model((next) => {
        expect(next.catalog._tag).toBe("Failure");
        expect(next.form.seats[0]?.model).toBe("acme/frontier-1");
      }),
      message(Message.ClickedRetryCatalog()),
      Command.expectExact(FetchCatalog()),
      Command.resolve(FetchCatalog, Message.SucceededFetchCatalog({ catalog })),
      model((next) => expect(next.catalog._tag).toBe("Success")),
    );
  });
});

/** Each seat's model search installs a blur guard on its toggle button when drawn. */
const acknowledgePickers = (seats: number) =>
  Array.from({ length: seats }, () =>
    Scene.Mount.resolve(
      Combobox.AttachComboboxPreventBlur,
      Combobox.Message.CompletedAttachComboboxPreventBlur(),
    ),
  );

describe("start-a-run view", () => {
  it("shows field errors after a failed submit", () => {
    Scene.scene(
      { update, view },
      Scene.given(loaded({ ...validForm, seeds: "0", openRouterKey: "" })),
      ...acknowledgePickers(2),
      Scene.submit(Scene.role("form")),
      Scene.expect(Scene.text("Seeds must be a whole number from 1 to 200.")).toExist(),
      Scene.expect(Scene.text("Paste your OpenRouter API key.")).toExist(),
    );
  });

  it("explains the game count and the estimated cost", () => {
    const estimate = estimateRunCost(validForm, catalog.models);

    Scene.scene(
      { update, view },
      Scene.given(loaded(validForm)),
      ...acknowledgePickers(2),
      Scene.expect(Scene.text(/8 games = seeds × 2 seating orders\./)).toExist(),
      Scene.expect(Scene.text(`≈ ${usd(estimate.totalUsd)}`)).toExist(),
      Scene.expect(Scene.text(/budget \(\$12\.50\) is the hard cap/)).toExist(),
      Scene.expect(Scene.text(/estimate is above the budget/)).toExist(),
    );
  });

  it("offers both ways to pay, and the own key is never stored", () => {
    Scene.scene(
      { update, view },
      Scene.given(loaded(validForm)),
      ...acknowledgePickers(2),
      Scene.expect(Scene.role("radio", { name: /My OpenRouter key/ })).toBeChecked(),
      Scene.expect(Scene.role("radio", { name: /Bench API key/ })).not.toBeChecked(),
      Scene.expect(Scene.text(/This page never saves it/)).toExist(),
      Scene.change(Scene.role("radio", { name: /Bench API key/ }), "server"),
      Scene.expect(Scene.placeholder("BENCH_API_KEY")).toExist(),
    );
  });
});
