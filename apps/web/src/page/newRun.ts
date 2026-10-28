/** `/runs/new`: the start-a-run form (seat builder, seeds, limits, budget, API key). */
import {
  BotPolicy,
  ModelCatalogEntry,
  Reasoning,
  RunConfig,
  RunSummary,
  TableFrequency,
  defaultModelCatalog,
} from "@mb/api";
import clsx from "clsx";
import { Effect, Option, Result, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command, Submodel, type Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Button, Input } from "@foldkit/ui";

import { withApi, type Api } from "../api/api.ts";
import { integer } from "../domain/format.ts";
import { providerColor } from "../domain/palette.ts";
import {
  MAX_SEATS,
  MIN_SEATS,
  RunForm,
  SeatDraft,
  defaultForm,
  errorsFor,
  gamesCount,
  llmSeat,
  validateRunForm,
  type FieldError,
} from "../domain/runForm.ts";
import { aboutRouter } from "../route.ts";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, INPUT, LABEL, botBadge, seatToken } from "../view/ui.ts";

const API_KEY_STORAGE_KEY = "mb.apiKey";

const CUSTOM_MODEL = "__custom__";

const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

// MODEL

export const Submission = defineTaggedUnion({
  Editing: {},
  Submitting: {},
  Failed: { error: Schema.String },
});

export type Submission = typeof Submission.Type;

export const Model = Schema.Struct({
  form: RunForm,
  catalog: Schema.Array(ModelCatalogEntry),
  submission: Submission,
  /** Field errors show after the first submit attempt. */
  isShowingErrors: Schema.Boolean,
});

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
  UpdatedSeeds: { value: Schema.String },
  UpdatedMaxRounds: { value: Schema.String },
  SelectedTableFrequency: { value: Schema.String },
  UpdatedConcurrency: { value: Schema.String },
  UpdatedBudget: { value: Schema.String },
  UpdatedApiKey: { value: Schema.String },
  ClickedForgetApiKey: {},
  ClickedAddLlmSeat: {},
  ClickedAddBotSeat: {},
  ClickedRemoveSeat: { index: Schema.Int },
  SelectedSeatModel: { index: Schema.Int, value: Schema.String },
  UpdatedSeatCustomModel: { index: Schema.Int, value: Schema.String },
  UpdatedSeatLabel: { index: Schema.Int, value: Schema.String },
  SelectedSeatReasoning: { index: Schema.Int, value: Schema.String },
  SelectedSeatPolicy: { index: Schema.Int, value: Schema.String },
  SubmittedForm: {},
  SucceededCreateRun: { run: RunSummary },
  FailedCreateRun: { error: Schema.String },
  CompletedSaveApiKey: {},
  SucceededFetchCatalog: { catalog: Schema.Array(ModelCatalogEntry) },
  FailedFetchCatalog: { error: Schema.String },
});

export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SavedApiKey: { apiKey: Schema.String },
  CreatedRun: { runId: Schema.String },
});

export type OutMessage = typeof OutMessage.Type;

// COMMAND

export const FetchCatalog = Command.define("FetchCatalog", {
  messages: [Message.SucceededFetchCatalog, Message.FailedFetchCatalog],
  execute: withApi((api) => api.models).pipe(
    Effect.map((response) => Message.SucceededFetchCatalog({ catalog: response.catalog })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchCatalog({ error }))),
  ),
});

export const CreateRun = Command.define("CreateRun", {
  args: { config: RunConfig, apiKey: Schema.String },
  messages: [Message.SucceededCreateRun, Message.FailedCreateRun],
  execute: ({ config, apiKey }) =>
    withApi((api) => api.createRun(config, apiKey)).pipe(
      Effect.map((run) => Message.SucceededCreateRun({ run })),
      Effect.catch((error) => Effect.succeed(Message.FailedCreateRun({ error }))),
    ),
});

export const SaveApiKey = Command.define("SaveApiKey", {
  args: { apiKey: Schema.String },
  messages: [Message.CompletedSaveApiKey],
  execute: ({ apiKey }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* apiKey === ""
        ? store.remove(API_KEY_STORAGE_KEY)
        : store.set(API_KEY_STORAGE_KEY, apiKey);
    }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedSaveApiKey()),
      Effect.provide(BrowserKeyValueStore.layerLocalStorage),
    ),
});

// INIT

export const init = (apiKey: string): Update.Return<Model, Message, Api> => ({
  model: {
    form: defaultForm(defaultModelCatalog, apiKey),
    catalog: defaultModelCatalog,
    submission: Submission.Editing(),
    isShowingErrors: false,
  },
  commands: [FetchCatalog()],
});

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Api>;

const decodeFrequency = Schema.decodeUnknownOption(TableFrequency);

const decodeReasoning = Schema.decodeUnknownOption(Reasoning);

const decodePolicy = Schema.decodeUnknownOption(BotPolicy);

const editForm = (model: Model, change: (form: RunForm) => RunForm): UpdateReturn => ({
  model: modifyFields(model, {
    form: change,
    submission: (submission) =>
      Submission.matchOrElse(submission, { Submitting: () => submission }, () =>
        Submission.Editing(),
      ),
  }),
});

const editSeat = (
  model: Model,
  index: number,
  change: (seat: SeatDraft) => SeatDraft,
): UpdateReturn =>
  editForm(model, (form) =>
    modifyFields(form, {
      seats: (seats) => seats.map((seat, position) => (position === index ? change(seat) : seat)),
    }),
  );

const editLlm =
  (change: (llm: typeof SeatDraft.Llm.Type) => SeatDraft) =>
  (seat: SeatDraft): SeatDraft =>
    SeatDraft.match(seat, { Llm: change, Bot: () => seat });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedName: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { name: () => value })),
    UpdatedSeeds: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { seeds: () => value })),
    UpdatedMaxRounds: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { maxRounds: () => value })),
    SelectedTableFrequency: ({ value }) =>
      editForm(model, (form) =>
        modifyFields(form, {
          tableFrequency: (current) => Option.getOrElse(decodeFrequency(value), () => current),
        }),
      ),
    UpdatedConcurrency: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { concurrency: () => value })),
    UpdatedBudget: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { budgetUsd: () => value })),
    UpdatedApiKey: ({ value }) =>
      editForm(model, (form) => modifyFields(form, { apiKey: () => value })),
    ClickedForgetApiKey: () => ({
      model: modifyFields(model, { form: (form) => modifyFields(form, { apiKey: () => "" }) }),
      commands: [SaveApiKey({ apiKey: "" })],
      outMessage: OutMessage.SavedApiKey({ apiKey: "" }),
    }),
    ClickedAddLlmSeat: () => {
      const entry = model.catalog[model.form.seats.length % Math.max(1, model.catalog.length)];
      const seat = entry === undefined ? SeatDraft.Bot({ policy: "heuristic" }) : llmSeat(entry);

      return model.form.seats.length >= MAX_SEATS
        ? { model }
        : editForm(model, (form) => modifyFields(form, { seats: (seats) => [...seats, seat] }));
    },
    ClickedAddBotSeat: () =>
      model.form.seats.length >= MAX_SEATS
        ? { model }
        : editForm(model, (form) =>
            modifyFields(form, {
              seats: (seats) => [...seats, SeatDraft.Bot({ policy: "heuristic" })],
            }),
          ),
    ClickedRemoveSeat: ({ index }) =>
      model.form.seats.length <= MIN_SEATS
        ? { model }
        : editForm(model, (form) =>
            modifyFields(form, {
              seats: (seats) => seats.filter((_, position) => position !== index),
            }),
          ),
    SelectedSeatModel: ({ index, value }) =>
      editSeat(model, index, (seat) => {
        if (value === CUSTOM_MODEL) {
          return SeatDraft.Llm({
            model: "",
            isCustom: true,
            label: "",
            reasoning: SeatDraft.matchOrElse(
              seat,
              { Llm: (llm) => llm.reasoning },
              () => "off" as const,
            ),
          });
        }

        const entry = model.catalog.find((candidate) => candidate.model === value);

        if (entry === undefined) return seat;

        return SeatDraft.Llm({
          model: entry.model,
          isCustom: false,
          label: entry.label,
          reasoning: SeatDraft.matchOrElse(
            seat,
            { Llm: (llm) => llm.reasoning },
            () => "off" as const,
          ),
        });
      }),
    UpdatedSeatCustomModel: ({ index, value }) =>
      editSeat(
        model,
        index,
        editLlm((llm) => SeatDraft.Llm({ ...llm, model: value })),
      ),
    UpdatedSeatLabel: ({ index, value }) =>
      editSeat(
        model,
        index,
        editLlm((llm) => SeatDraft.Llm({ ...llm, label: value })),
      ),
    SelectedSeatReasoning: ({ index, value }) =>
      editSeat(
        model,
        index,
        editLlm((llm) =>
          SeatDraft.Llm({
            ...llm,
            reasoning: Option.getOrElse(decodeReasoning(value), () => llm.reasoning),
          }),
        ),
      ),
    SelectedSeatPolicy: ({ index, value }) =>
      editSeat(model, index, (seat) =>
        Option.match(decodePolicy(value), {
          onNone: () => seat,
          onSome: (policy) => SeatDraft.Bot({ policy }),
        }),
      ),
    SubmittedForm: () => {
      const apiKey = model.form.apiKey.trim();

      return Result.match(validateRunForm(model.form), {
        onFailure: () => ({ model: modifyFields(model, { isShowingErrors: () => true }) }),
        onSuccess: (config: RunConfig) => ({
          model: modifyFields(model, {
            isShowingErrors: () => true,
            submission: () => Submission.Submitting(),
          }),
          commands: [CreateRun({ config, apiKey }), SaveApiKey({ apiKey })],
          outMessage: OutMessage.SavedApiKey({ apiKey }),
        }),
      });
    },
    SucceededCreateRun: ({ run }) => ({
      model: modifyFields(model, { submission: () => Submission.Editing() }),
      outMessage: OutMessage.CreatedRun({ runId: run.id }),
    }),
    FailedCreateRun: ({ error }) => ({
      model: modifyFields(model, { submission: () => Submission.Failed({ error }) }),
    }),
    CompletedSaveApiKey: () => ({ model }),
    SucceededFetchCatalog: ({ catalog }) => ({
      model: modifyFields(model, {
        catalog: () => (catalog.length === 0 ? model.catalog : catalog),
      }),
    }),
    FailedFetchCatalog: () => ({ model }),
  });

// VIEW

const fieldErrors = (h: HtmlBuilder<Message>, errors: ReadonlyArray<string>): Html =>
  errors.length === 0
    ? h.empty
    : h.ul(
        [h.Class("mt-1 space-y-0.5 text-xs font-semibold text-red"), h.Role("alert")],
        errors.map((error) => h.li([], [error])),
      );

const textField = (
  h: HtmlBuilder<Message>,
  config: Readonly<{
    id: string;
    label: string;
    value: string;
    placeholder: string;
    hint: string;
    type?: string;
    errors: ReadonlyArray<string>;
    onInput: (value: string) => Message;
  }>,
): Html =>
  Input.view(
    {
      id: config.id,
      value: config.value,
      placeholder: config.placeholder,
      type: config.type ?? "text",
      isInvalid: config.errors.length > 0,
      hasDescription: true,
      onInput: config.onInput,
      toView: (attributes) =>
        h.div(
          [],
          [
            h.label([...attributes.label, h.Class(LABEL)], [config.label]),
            h.input([
              ...attributes.input,
              h.Class(clsx(INPUT, { "border-red": config.errors.length > 0 })),
            ]),
            h.p([...attributes.description, h.Class("mt-1 text-xs text-muted")], [config.hint]),
            fieldErrors(h, config.errors),
          ],
        ),
    },
    h,
  );

const smallSelect = (
  h: HtmlBuilder<Message>,
  label: string,
  value: string,
  options: ReadonlyArray<readonly [string, string]>,
  onChange: (value: string) => Message,
): Html =>
  h.label(
    [h.Class("block min-w-0")],
    [
      h.span([h.Class(LABEL)], [label]),
      h.select(
        [h.Class(INPUT), h.OnChange(onChange)],
        options.map(([optionValue, optionLabel]) =>
          h.option([h.Value(optionValue), h.Selected(optionValue === value)], [optionLabel]),
        ),
      ),
    ],
  );

const REASONING_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["off", "Off"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

const seatCard = (
  model: Model,
  seat: SeatDraft,
  index: number,
  errors: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const letter = SEAT_LETTERS[index] ?? "A";
  const canRemove = model.form.seats.length > MIN_SEATS;

  const body = SeatDraft.match(seat, {
    Llm: (llm) =>
      h.div(
        [h.Class("grid gap-3 sm:grid-cols-2")],
        [
          smallSelect(
            h,
            "Model",
            llm.isCustom ? CUSTOM_MODEL : llm.model,
            [
              ...model.catalog.map((entry): readonly [string, string] => [
                entry.model,
                `${entry.label} · ${entry.provider}`,
              ]),
              [CUSTOM_MODEL, "Custom OpenRouter id…"],
            ],
            (value) => Message.SelectedSeatModel({ index, value }),
          ),
          smallSelect(h, "Reasoning effort", llm.reasoning, REASONING_OPTIONS, (value) =>
            Message.SelectedSeatReasoning({ index, value }),
          ),
          llm.isCustom
            ? h.label(
                [h.Class("block")],
                [
                  h.span([h.Class(LABEL)], ["OpenRouter model id"]),
                  h.input([
                    h.Class(INPUT),
                    h.Value(llm.model),
                    h.Placeholder("provider/model"),
                    h.OnInput((value) => Message.UpdatedSeatCustomModel({ index, value })),
                  ]),
                ],
              )
            : h.empty,
          h.label(
            [h.Class("block")],
            [
              h.span([h.Class(LABEL)], ["Label"]),
              h.input([
                h.Class(INPUT),
                h.Value(llm.label),
                h.Placeholder("Shown on the leaderboard"),
                h.OnInput((value) => Message.UpdatedSeatLabel({ index, value })),
              ]),
            ],
          ),
        ],
      ),
    Bot: (bot) =>
      h.div(
        [h.Class("grid gap-3 sm:grid-cols-2")],
        [
          smallSelect(
            h,
            "Policy",
            bot.policy,
            [
              ["heuristic", "Heuristic: buys, builds and trades sensibly"],
              ["random", "Random: legal moves at random"],
            ],
            (value) => Message.SelectedSeatPolicy({ index, value }),
          ),
          h.p(
            [h.Class("self-end text-xs text-muted")],
            ["Bots run inside the game server, cost nothing and are rated as baselines."],
          ),
        ],
      ),
  });

  return h.keyed("li")(
    `seat-${index}`,
    [
      h.Class(
        clsx(
          "rounded-md border-[1.5px] bg-paper p-3",
          errors.length > 0 ? "border-red" : "border-line",
        ),
      ),
    ],
    [
      h.div(
        [h.Class("mb-3 flex items-center gap-2")],
        [
          seatToken(h, letter, "md"),
          h.span([h.Class("text-sm font-semibold text-ink")], [`Seat ${letter}`]),
          SeatDraft.match(seat, {
            Llm: (llm) =>
              h.span([
                h.Class("ml-1 h-2.5 w-2.5 rounded-full"),
                h.Style({ background: providerColor(llm.model) }),
              ]),
            Bot: () => botBadge(h),
          }),
          h.button(
            [
              h.Type("button"),
              h.Class(
                "ml-auto rounded px-2 py-1 text-xs font-semibold text-muted hover:bg-red/10 hover:text-red disabled:opacity-30",
              ),
              h.Disabled(!canRemove),
              h.AriaLabel(`Remove seat ${letter}`),
              h.OnClick(Message.ClickedRemoveSeat({ index })),
            ],
            ["Remove"],
          ),
        ],
      ),
      body,
      fieldErrors(h, errors),
    ],
  );
};

const FREQUENCY_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["everyTurn", "Before every turn (default)"],
  ["everyRoll", "Before every roll (also after doubles)"],
  ["everyRound", "Once per full round"],
  ["off", "Off: no open table"],
];

const formErrors = (model: Model): ReadonlyArray<FieldError> =>
  model.isShowingErrors
    ? Result.match(validateRunForm(model.form), {
        onFailure: (errors) => errors,
        onSuccess: () => [],
      })
    : [];

const submitButton = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isSubmitting = Submission.guards.Submitting(model.submission);

  return Button.view(
    {
      type: "submit",
      isDisabled: isSubmitting,
      toView: (attributes) =>
        h.button(
          [...attributes.button, h.Class(BUTTON_PRIMARY)],
          [isSubmitting ? "Starting…" : "Start run"],
        ),
    },
    h,
  );
};

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const errors = formErrors(model);
  const games = gamesCount(model.form);
  const llmSeats = model.form.seats.filter((seat) => SeatDraft.guards.Llm(seat)).length;

  return h.div(
    [h.Class("mx-auto max-w-5xl px-4 py-10 sm:px-6")],
    [
      h.div(
        [h.Class("mb-6")],
        [
          h.p([h.Class("deed-kicker text-red")], ["Run the benchmark"]),
          h.h1([h.Class("display mt-1 text-4xl text-ink")], ["Start a run"]),
          h.p(
            [h.Class("mt-2 max-w-3xl text-sm text-ink-2")],
            [
              "A run plays every seed once per seat rotation, so each competitor sits in every chair with the same dice and decks. Results feed the public leaderboard. Starting runs needs the bench API key (they spend real money on model calls); browsing, live games and replays are public. ",
              h.a(
                [h.Href(aboutRouter()), h.Class("font-semibold text-ink underline")],
                ["How runs are rated"],
              ),
            ],
          ),
        ],
      ),
      h.form(
        [h.Class("space-y-6"), h.Novalidate(true), h.OnSubmit(Message.SubmittedForm())],
        [
          h.section(
            [h.Class("deed p-5")],
            [
              h.div(
                [h.Class("mb-4 flex flex-wrap items-center justify-between gap-2")],
                [
                  h.div(
                    [],
                    [
                      h.h2([h.Class("display text-xl text-ink")], ["Seats"]),
                      h.p(
                        [h.Class("text-xs text-muted")],
                        [
                          `${model.form.seats.length} of ${MAX_SEATS} seats · seat order is the turn order of the first rotation`,
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("flex gap-2")],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.Class(BUTTON_SECONDARY),
                          h.Disabled(model.form.seats.length >= MAX_SEATS),
                          h.OnClick(Message.ClickedAddLlmSeat()),
                        ],
                        ["+ Model"],
                      ),
                      h.button(
                        [
                          h.Type("button"),
                          h.Class(BUTTON_SECONDARY),
                          h.Disabled(model.form.seats.length >= MAX_SEATS),
                          h.OnClick(Message.ClickedAddBotSeat()),
                        ],
                        ["+ Bot"],
                      ),
                    ],
                  ),
                ],
              ),
              h.ol(
                [h.Class("grid gap-3 md:grid-cols-2")],
                model.form.seats.map((seat, index) =>
                  seatCard(model, seat, index, errorsFor(errors, `seat-${index}`), h),
                ),
              ),
              fieldErrors(h, errorsFor(errors, "seats")),
            ],
          ),
          h.section(
            [h.Class("deed grid gap-4 p-5 md:grid-cols-3")],
            [
              h.div(
                [h.Class("md:col-span-3")],
                [h.h2([h.Class("display text-xl text-ink")], ["Games"])],
              ),
              textField(h, {
                id: "run-name",
                label: "Run name",
                value: model.form.name,
                placeholder: "Frontier league",
                hint: "Optional, shown on the runs page.",
                errors: errorsFor(errors, "name"),
                onInput: (value) => Message.UpdatedName({ value }),
              }),
              textField(h, {
                id: "run-seeds",
                label: "Seeds",
                value: model.form.seeds,
                placeholder: "3",
                hint: `${integer(games)} games = seeds × ${model.form.seats.length} seats.`,
                errors: errorsFor(errors, "seeds"),
                onInput: (value) => Message.UpdatedSeeds({ value }),
              }),
              textField(h, {
                id: "run-max-rounds",
                label: "Max rounds",
                value: model.form.maxRounds,
                placeholder: "120",
                hint: "Turn cap in full rounds; empty for the default (120).",
                errors: errorsFor(errors, "maxRounds"),
                onInput: (value) => Message.UpdatedMaxRounds({ value }),
              }),
              smallSelect(h, "Open table", model.form.tableFrequency, FREQUENCY_OPTIONS, (value) =>
                Message.SelectedTableFrequency({ value }),
              ),
              textField(h, {
                id: "run-concurrency",
                label: "Concurrency",
                value: model.form.concurrency,
                placeholder: "2",
                hint: "Games played at the same time.",
                errors: errorsFor(errors, "concurrency"),
                onInput: (value) => Message.UpdatedConcurrency({ value }),
              }),
              textField(h, {
                id: "run-budget",
                label: "Budget (USD)",
                value: model.form.budgetUsd,
                placeholder: "25",
                hint:
                  llmSeats === 0
                    ? "Bot-only runs cost nothing."
                    : "Hard cap: no new model calls once reached; games abort.",
                errors: errorsFor(errors, "budgetUsd"),
                onInput: (value) => Message.UpdatedBudget({ value }),
              }),
            ],
          ),
          h.section(
            [h.Class("banknote grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-end")],
            [
              h.div(
                [],
                [
                  textField(h, {
                    id: "run-api-key",
                    label: "Bench API key",
                    value: model.form.apiKey,
                    placeholder: "BENCH_API_KEY",
                    type: "password",
                    hint: "Kept in this browser (localStorage) and sent as an Authorization: Bearer header. Only needed to start or cancel runs.",
                    errors: errorsFor(errors, "apiKey"),
                    onInput: (value) => Message.UpdatedApiKey({ value }),
                  }),
                ],
              ),
              model.form.apiKey === ""
                ? h.empty
                : h.button(
                    [
                      h.Type("button"),
                      h.Class("text-xs font-semibold text-muted underline hover:text-red"),
                      h.OnClick(Message.ClickedForgetApiKey()),
                    ],
                    ["Forget key"],
                  ),
            ],
          ),
          h.div(
            [h.Class("flex flex-wrap items-center gap-4")],
            [
              submitButton(model, h),
              h.p(
                [h.Class("text-sm text-ink-2")],
                [
                  `${integer(games)} games · ${model.form.seats.length} seats · ${llmSeats} with models`,
                ],
              ),
              Submission.match(model.submission, {
                Editing: () => h.empty,
                Submitting: () => h.empty,
                Failed: ({ error }) =>
                  h.p(
                    [h.Class("text-sm font-semibold text-red"), h.Role("alert")],
                    [`Could not start the run: ${error}`],
                  ),
              }),
              fieldErrors(h, errorsFor(errors, "form")),
            ],
          ),
        ],
      ),
    ],
  );
});
