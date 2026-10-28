/**
 * `/runs/new`: the start-a-run form. Seats are picked from the live OpenRouter catalog
 * (`GET /api/catalog`) with a searchable picker per seat; the run is paid with the creator's own
 * OpenRouter key or with server credit (bench API key), and the page shows a rough cost estimate.
 */
import {
  CatalogResponse,
  CreateRunResponse,
  Reasoning,
  RunConfig,
  RunFunding,
  TableFrequency,
  type ModelCatalogEntry,
} from "@mb/api";
import clsx from "clsx";
import { Effect, Option, Result, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { AsyncData, Command, Submodel, Update } from "foldkit";
import { childAttributes, type Html, type HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { BrowserKeyValueStore } from "@effect/platform-browser";
import { Button, Combobox, Input } from "@foldkit/ui";

import { RunPayment, withApi, type Api } from "../api/api.ts";
import { contextWindow, integer, perMTok, usd } from "../domain/format.ts";
import { failWith, reload, succeedWith } from "../domain/remote.ts";
import {
  MAX_SEATS,
  MIN_SEATS,
  RunForm,
  SeatDraft,
  budgetOf,
  defaultForm,
  errorsFor,
  estimateRunCost,
  findModel,
  gamesCount,
  orderCatalog,
  pickModel,
  searchCatalog,
  seatFor,
  validateRunForm,
  withCatalog,
  type FieldError,
  type ValidRun,
} from "../domain/runForm.ts";
import { aboutRouter } from "../route.ts";
import { providerIcon } from "../view/provider.ts";
import {
  BUTTON_GHOST,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  INPUT,
  LABEL,
  seatToken,
} from "../view/ui.ts";

const API_KEY_STORAGE_KEY = "mb.apiKey";

const SEAT_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

/** The model search of one seat; items are OpenRouter model ids. */
export const ModelPicker = Combobox.create<string>();

// MODEL

export const Submission = defineTaggedUnion({
  Editing: {},
  Submitting: {},
  Failed: { error: Schema.String },
});

export type Submission = typeof Submission.Type;

export const CatalogAsyncData = AsyncData.Schema(CatalogResponse, Schema.String);

export const Model = Schema.Struct({
  form: RunForm,
  catalog: CatalogAsyncData.schema,
  /** One model search per seat, in seat order; its id is the seat's stable key. */
  pickers: Schema.Array(Combobox.Model),
  /** Number for the next seat's picker id. */
  nextSeatNumber: Schema.Int,
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
  SelectedFunding: { value: Schema.String },
  UpdatedOpenRouterKey: { value: Schema.String },
  UpdatedApiKey: { value: Schema.String },
  ClickedForgetApiKey: {},
  ClickedAddSeat: {},
  ClickedRemoveSeat: { seatId: Schema.String },
  GotSeatPickerMessage: { seatId: Schema.String, message: Combobox.Message },
  UpdatedSeatModelId: { seatId: Schema.String, value: Schema.String },
  UpdatedSeatLabel: { seatId: Schema.String, value: Schema.String },
  SelectedSeatReasoning: { seatId: Schema.String, value: Schema.String },
  ClickedRetryCatalog: {},
  SubmittedForm: {},
  SucceededCreateRun: { response: CreateRunResponse },
  FailedCreateRun: { error: Schema.String },
  CompletedSaveApiKey: {},
  SucceededFetchCatalog: { catalog: CatalogResponse },
  FailedFetchCatalog: { error: Schema.String },
});

export type Message = typeof Message.Type;

export const OutMessage = defineMessageUnion({
  SavedApiKey: { apiKey: Schema.String },
  /** `cancelToken` is set for own-key runs: the page keeps it to cancel the run later. */
  CreatedRun: { runId: Schema.String, cancelToken: Schema.Option(Schema.String) },
});

export type OutMessage = typeof OutMessage.Type;

// COMMAND

export const FetchCatalog = Command.define("FetchCatalog", {
  messages: [Message.SucceededFetchCatalog, Message.FailedFetchCatalog],
  execute: withApi((api) => api.catalog).pipe(
    Effect.map((catalog) => Message.SucceededFetchCatalog({ catalog })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchCatalog({ error }))),
  ),
});

export const CreateRun = Command.define("CreateRun", {
  args: { config: RunConfig, payment: RunPayment },
  messages: [Message.SucceededCreateRun, Message.FailedCreateRun],
  execute: ({ config, payment }) =>
    withApi((api) => api.createRun(config, payment)).pipe(
      Effect.map((response) => Message.SucceededCreateRun({ response })),
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

const pickerFor = (seatNumber: number): Combobox.Model =>
  Combobox.init({ id: `seat-model-${seatNumber}` });

export const init = (apiKey: string): Update.Return<Model, Message, Api> => {
  const form = defaultForm(apiKey);

  return {
    model: {
      form,
      catalog: CatalogAsyncData.Loading(),
      pickers: form.seats.map((_, index) => pickerFor(index + 1)),
      nextSeatNumber: form.seats.length + 1,
      submission: Submission.Editing(),
      isShowingErrors: false,
    },
    commands: [FetchCatalog()],
  };
};

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Api>;

const decodeFrequency = Schema.decodeUnknownOption(TableFrequency);

const decodeReasoning = Schema.decodeUnknownOption(Reasoning);

const decodeFunding = Schema.decodeUnknownOption(RunFunding);

/** The loaded catalog's models, if any (validation and estimates use them). */
export const catalogModels = (model: Model): Option.Option<ReadonlyArray<ModelCatalogEntry>> =>
  Option.map(AsyncData.getData(model.catalog), (catalog) => catalog.models);

/** Applies a form edit; a failed submission goes back to editing. */
const editForm = (model: Model, change: (form: RunForm) => RunForm): Model =>
  modifyFields(model, {
    form: change,
    submission: (submission) =>
      Submission.matchOrElse(submission, { Submitting: () => submission }, () =>
        Submission.Editing(),
      ),
  });

const seatIndex = (model: Model, seatId: string): number =>
  model.pickers.findIndex((picker) => picker.id === seatId);

const editSeat = (model: Model, seatId: string, change: (seat: SeatDraft) => SeatDraft): Model => {
  const index = seatIndex(model, seatId);

  return index < 0
    ? model
    : editForm(model, (form) =>
        modifyFields(form, {
          seats: (seats) =>
            seats.map((seat, position) => (position === index ? change(seat) : seat)),
        }),
      );
};

/** Seats the catalog model `modelId` (picked in the seat's search). */
const selectModel = (model: Model, seatId: string, modelId: string): Model =>
  Option.match(
    Option.flatMap(catalogModels(model), (models) =>
      Option.fromNullishOr(findModel(models, modelId)),
    ),
    {
      onNone: () => model,
      onSome: (found) => editSeat(model, seatId, (seat) => pickModel(seat, found)),
    },
  );

const foldSeatPickerOutMessage = (seatId: string) =>
  Combobox.OutMessage.match<Update.Step<Model, Message, Api>, Combobox.OutMessage<string>>({
    Selected:
      ({ value }) =>
      (model) => ({ model: selectModel(model, seatId, value) }),
    ClearedSelection: () => (model) => ({ model }),
  });

const foldSeatPicker = Update.foldChildAt({
  update: ModelPicker.update,
  readAt: (model: Model, seatId: string) =>
    Option.fromNullishOr(model.pickers.find((picker) => picker.id === seatId)),
  writeAt: (model, seatId, nextPicker) =>
    modifyFields(model, {
      pickers: (pickers) => pickers.map((picker) => (picker.id === seatId ? nextPicker : picker)),
    }),
  toParentMessage: (seatId, message) => Message.GotSeatPickerMessage({ seatId, message }),
  foldOutMessage: foldSeatPickerOutMessage,
});

/** The next seat: the first featured model not seated yet (or the first catalog model). */
const nextSeat = (model: Model): SeatDraft => {
  const ordered = orderCatalog(Option.getOrElse(catalogModels(model), () => []));

  const unseated = ordered.find(
    (entry) => !model.form.seats.some((seat) => seat.model === entry.model),
  );

  const entry = unseated ?? ordered[0];

  return entry === undefined ? { model: "", label: "", reasoning: "off" } : seatFor(entry);
};

const submit = (model: Model, valid: ValidRun): UpdateReturn => {
  const submitting = modifyFields(model, {
    isShowingErrors: () => true,
    submission: () => Submission.Submitting(),
  });

  return RunPayment.match(valid.payment, {
    OwnKey: () => ({
      model: submitting,
      commands: [CreateRun({ config: valid.config, payment: valid.payment })],
    }),
    BenchKey: ({ apiKey }) => ({
      model: submitting,
      commands: [
        CreateRun({ config: valid.config, payment: valid.payment }),
        SaveApiKey({ apiKey }),
      ],
      outMessage: OutMessage.SavedApiKey({ apiKey }),
    }),
  });
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedName: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { name: () => value })),
    }),
    UpdatedSeeds: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { seeds: () => value })),
    }),
    UpdatedMaxRounds: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { maxRounds: () => value })),
    }),
    SelectedTableFrequency: ({ value }) => ({
      model: editForm(model, (form) =>
        modifyFields(form, {
          tableFrequency: (current) => Option.getOrElse(decodeFrequency(value), () => current),
        }),
      ),
    }),
    UpdatedConcurrency: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { concurrency: () => value })),
    }),
    UpdatedBudget: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { budgetUsd: () => value })),
    }),
    SelectedFunding: ({ value }) => ({
      model: editForm(model, (form) =>
        modifyFields(form, {
          funding: (current) => Option.getOrElse(decodeFunding(value), () => current),
        }),
      ),
    }),
    UpdatedOpenRouterKey: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { openRouterKey: () => value })),
    }),
    UpdatedApiKey: ({ value }) => ({
      model: editForm(model, (form) => modifyFields(form, { apiKey: () => value })),
    }),
    ClickedForgetApiKey: () => ({
      model: modifyFields(model, { form: (form) => modifyFields(form, { apiKey: () => "" }) }),
      commands: [SaveApiKey({ apiKey: "" })],
      outMessage: OutMessage.SavedApiKey({ apiKey: "" }),
    }),
    ClickedAddSeat: () => {
      if (model.form.seats.length >= MAX_SEATS) return { model };

      const seat = nextSeat(model);

      const edited = editForm(model, (form) =>
        modifyFields(form, { seats: (seats) => [...seats, seat] }),
      );

      return {
        model: modifyFields(edited, {
          pickers: (pickers) => [...pickers, pickerFor(model.nextSeatNumber)],
          nextSeatNumber: (number) => number + 1,
        }),
      };
    },
    ClickedRemoveSeat: ({ seatId }) => {
      const index = seatIndex(model, seatId);

      if (index < 0 || model.form.seats.length <= MIN_SEATS) return { model };

      const edited = editForm(model, (form) =>
        modifyFields(form, {
          seats: (seats) => seats.filter((_, position) => position !== index),
        }),
      );

      return {
        model: modifyFields(edited, {
          pickers: (pickers) => pickers.filter((picker) => picker.id !== seatId),
        }),
      };
    },
    GotSeatPickerMessage: ({ seatId, message: pickerMessage }) =>
      foldSeatPicker(model, seatId, pickerMessage),
    UpdatedSeatModelId: ({ seatId, value }) => ({
      model: editSeat(model, seatId, (seat) => ({ ...seat, model: value })),
    }),
    UpdatedSeatLabel: ({ seatId, value }) => ({
      model: editSeat(model, seatId, (seat) => ({ ...seat, label: value })),
    }),
    SelectedSeatReasoning: ({ seatId, value }) => ({
      model: editSeat(model, seatId, (seat) => ({
        ...seat,
        reasoning: Option.getOrElse(decodeReasoning(value), () => seat.reasoning),
      })),
    }),
    ClickedRetryCatalog: () => ({
      model: modifyFields(model, { catalog: reload }),
      commands: [FetchCatalog()],
    }),
    SubmittedForm: () =>
      Result.match(validateRunForm(model.form, catalogModels(model)), {
        onFailure: () => ({ model: modifyFields(model, { isShowingErrors: () => true }) }),
        onSuccess: (valid) => submit(model, valid),
      }),
    SucceededCreateRun: ({ response }) => ({
      model: modifyFields(model, {
        submission: () => Submission.Editing(),
        form: (form) => modifyFields(form, { openRouterKey: () => "" }),
      }),
      outMessage: OutMessage.CreatedRun({
        runId: response.run.id,
        cancelToken: Option.fromNullishOr(response.cancelToken),
      }),
    }),
    FailedCreateRun: ({ error }) => ({
      model: modifyFields(model, { submission: () => Submission.Failed({ error }) }),
    }),
    CompletedSaveApiKey: () => ({ model }),
    SucceededFetchCatalog: ({ catalog }) =>
      catalog.models.length === 0
        ? {
            model: modifyFields(model, {
              catalog: failWith("The model catalog is empty"),
            }),
          }
        : {
            model: modifyFields(model, {
              catalog: succeedWith(catalog),
              form: (form) =>
                modifyFields(form, { seats: (seats) => withCatalog(seats, catalog.models) }),
            }),
          },
    FailedFetchCatalog: ({ error }) => ({
      model: modifyFields(model, { catalog: failWith(error) }),
    }),
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
    hint: string | Html;
    type?: string;
    isSecret?: boolean;
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
              ...(config.isSecret === true ? [h.Autocomplete("off"), h.Spellcheck(false)] : []),
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

/** `≈ $3.56`: the catalog's rough cost of one seat in a full 4-player game. */
const seatCostText = (entry: ModelCatalogEntry): string => {
  if (entry.estimatedSeatCostUsd === null) return "no price";

  return entry.estimatedSeatCostUsd === 0 ? "free" : `≈ ${usd(entry.estimatedSeatCostUsd)}`;
};

/** Reasoning, context window and prices of a catalog model, as small facts. */
const modelFacts = (h: HtmlBuilder<Message>, entry: ModelCatalogEntry): ReadonlyArray<Html> => [
  entry.reasoning
    ? h.span(
        [
          h.Class(
            "rounded-sm bg-[#ece4fb] px-1 text-[10px] font-bold tracking-wide text-[#5b2bb5] uppercase",
          ),
          h.Title("Supports a reasoning effort"),
        ],
        ["Reasoning"],
      )
    : h.empty,
  entry.contextLength === null
    ? h.empty
    : h.span([h.Title("Context window")], [`${contextWindow(entry.contextLength)} ctx`]),
  entry.pricing === null
    ? h.span([], ["no pricing"])
    : h.span(
        [h.Class("num"), h.Title("USD per million tokens: input / output")],
        [
          `${perMTok(entry.pricing.inputPerMTok)} / ${perMTok(entry.pricing.outputPerMTok)} per MTok`,
        ],
      ),
];

const pickerItem = (h: HtmlBuilder<Message>, entry: ModelCatalogEntry, isSelected: boolean): Html =>
  h.div(
    [h.Class("flex items-start gap-2.5")],
    [
      h.span([h.Class("mt-0.5")], [providerIcon(h, entry.providerSlug, "sm", entry.provider)]),
      h.div(
        [h.Class("min-w-0 flex-1")],
        [
          h.div(
            [h.Class("flex items-baseline gap-2")],
            [
              h.span([h.Class("truncate font-semibold text-ink")], [entry.label]),
              isSelected
                ? h.span([h.Class("shrink-0 text-[10px] font-bold text-red uppercase")], ["Seated"])
                : h.empty,
              h.span(
                [
                  h.Class("num ml-auto shrink-0 text-xs font-semibold text-money"),
                  h.Title("Rough cost of one seat in a full 4-player game"),
                ],
                [seatCostText(entry)],
              ),
            ],
          ),
          h.div(
            [h.Class("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted")],
            [h.span([h.Class("num max-w-full truncate")], [entry.model]), ...modelFacts(h, entry)],
          ),
        ],
      ),
    ],
  );

const FEATURED_GROUP = "featured";

const groupHeading = (
  h: HtmlBuilder<Message>,
  groupKey: string,
  providers: ReadonlyMap<string, string>,
): Combobox.GroupHeading => ({
  className:
    "sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-paper-2 px-3 py-1.5 deed-kicker text-ink-2",
  content:
    groupKey === FEATURED_GROUP
      ? h.span(
          [h.Class("flex items-center gap-2")],
          [h.span([h.Class("text-red")], ["★"]), "Featured"],
        )
      : h.span(
          [h.Class("flex items-center gap-2")],
          [
            providerIcon(h, groupKey, "xs", providers.get(groupKey)),
            providers.get(groupKey) ?? groupKey,
          ],
        ),
});

const PICKER_ANCHOR = { placement: "bottom-start", gap: 6, padding: 8 } as const;

const pickerView = (
  model: Model,
  picker: Combobox.Model,
  seat: SeatDraft,
  catalog: CatalogResponse,
  h: HtmlBuilder<Message>,
): Html => {
  // Only the open search lists (and sorts) models; closed ones render just their input.
  const matches = picker.isOpen
    ? searchCatalog(orderCatalog(catalog.models), picker.inputValue)
    : [];

  const byId = new Map(matches.map((entry) => [entry.model, entry]));
  const providers = new Map(matches.map((entry) => [entry.providerSlug, entry.provider]));
  const isSubmitting = Submission.guards.Submitting(model.submission);

  return h.div(
    [h.Class("space-y-1")],
    [
      h.label([h.For(Combobox.inputId(picker.id)), h.Class(LABEL)], ["Change model"]),
      h.submodel({
        slotId: picker.id,
        model: picker,
        view: ModelPicker.view,
        viewInputs: {
          items: matches.map((entry) => entry.model),
          restingInputValue: "",
          maybeSelectedValue: seat.model === "" ? Option.none() : Option.some(seat.model),
          itemToValue: (item) => item,
          itemToDisplayText: () => "",
          itemToConfig: (item, context) => {
            const entry = byId.get(item);

            return {
              className: clsx(
                "cursor-pointer border-b border-line/60 px-3 py-2 text-sm last:border-b-0",
                context.isActive ? "bg-board/60" : "bg-paper",
              ),
              content:
                entry === undefined ? h.span([], [item]) : pickerItem(h, entry, context.isSelected),
            };
          },
          itemGroupKey: (item) =>
            byId.get(item)?.featured === true
              ? FEATURED_GROUP
              : (byId.get(item)?.providerSlug ?? "other"),
          groupToHeading: (groupKey) => groupHeading(h, groupKey, providers),
          openOnFocus: true,
          isDisabled: isSubmitting,
          inputPlaceholder: `Search ${integer(catalog.models.length)} models by name, provider or id`,
          inputAttributes: childAttributes([
            h.Class(clsx(INPUT, "pr-9")),
            h.Autocomplete("off"),
            h.Spellcheck(false),
          ]),
          inputWrapperAttributes: childAttributes([h.Class("relative")]),
          buttonContent: h.span([h.AriaHidden(true)], ["▾"]),
          buttonAttributes: childAttributes([
            h.Class(
              "absolute inset-y-0 right-0 flex items-center px-3 text-sm text-muted hover:text-ink",
            ),
            h.AriaLabel("Show models"),
          ]),
          itemsAttributes: childAttributes([
            h.Class(
              "z-40 max-h-96 w-(--button-width) overflow-y-auto sm:min-w-[20rem] rounded-md border-[1.5px] border-line-strong bg-paper shadow-[4px_4px_0_var(--shadow)] outline-none empty:hidden",
            ),
          ]),
          backdropAttributes: childAttributes([h.Class("fixed inset-0 z-30")]),
          attributes: childAttributes([h.Class("relative")]),
          anchor: PICKER_ANCHOR,
        },
        toParentMessage: (message) => Message.GotSeatPickerMessage({ seatId: picker.id, message }),
      }),
      picker.isOpen && matches.length === 0
        ? h.p(
            [h.Class("text-xs text-muted"), h.Role("status")],
            [`No model matches “${picker.inputValue}”.`],
          )
        : h.empty,
    ],
  );
};

/** The chosen model of a seat: logo, name, id and what it costs. */
const seatModelView = (
  h: HtmlBuilder<Message>,
  seat: SeatDraft,
  catalog: AsyncData.AsyncData<CatalogResponse, string>,
): Html => {
  const entry = Option.flatMap(AsyncData.getData(catalog), (loaded) =>
    Option.fromNullishOr(findModel(loaded.models, seat.model)),
  );

  return Option.match(entry, {
    onNone: () =>
      h.div(
        [h.Class("rounded-md border border-dashed border-line bg-paper-2 px-3 py-2 text-sm")],
        [
          h.p(
            [h.Class("num truncate text-ink")],
            [seat.model === "" ? "No model yet" : seat.model],
          ),
          h.p(
            [h.Class("text-xs text-muted")],
            [
              AsyncData.matchData(catalog, {
                onEmpty: () => "Loading prices…",
                onFailure: () => "Prices unavailable: the catalog did not load.",
                onData: () => "Not in the catalog: pick another model.",
              }),
            ],
          ),
        ],
      ),
    onSome: (found) =>
      h.div(
        [h.Class("flex items-start gap-3 rounded-md border border-line bg-paper-2 px-3 py-2.5")],
        [
          providerIcon(h, found.providerSlug, "md", found.provider),
          h.div(
            [h.Class("min-w-0 flex-1")],
            [
              h.div(
                [h.Class("flex items-baseline gap-2")],
                [
                  h.p([h.Class("truncate font-semibold text-ink")], [found.label]),
                  h.p(
                    [
                      h.Class("num ml-auto shrink-0 text-sm font-bold text-money"),
                      h.Title("Rough cost of this seat in a full 4-player game"),
                    ],
                    [seatCostText(found)],
                  ),
                ],
              ),
              h.p([h.Class("num truncate text-[11px] text-muted")], [found.model]),
              h.div(
                [
                  h.Class(
                    "mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-2",
                  ),
                ],
                [h.span([], [found.provider]), ...modelFacts(h, found)],
              ),
            ],
          ),
        ],
      ),
  });
};

const seatCard = (
  model: Model,
  seat: SeatDraft,
  picker: Combobox.Model,
  index: number,
  errors: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const letter = SEAT_LETTERS[index] ?? "A";
  const canRemove = model.form.seats.length > MIN_SEATS;
  const seatId = picker.id;

  const entry = Option.flatMap(catalogModels(model), (models) =>
    Option.fromNullishOr(findModel(models, seat.model)),
  );

  const supportsReasoning = Option.match(entry, {
    onNone: () => true,
    onSome: (found) => found.reasoning,
  });

  const modelInput = AsyncData.matchData(model.catalog, {
    onEmpty: () =>
      h.div(
        [h.Class("space-y-1")],
        [
          h.span([h.Class(LABEL)], ["Change model"]),
          h.input([
            h.Class(clsx(INPUT, "opacity-60")),
            h.Disabled(true),
            h.Placeholder("Loading the model catalog…"),
            h.AriaLabel("Model search (loading)"),
          ]),
        ],
      ),
    onFailure: () =>
      h.label(
        [h.Class("block")],
        [
          h.span([h.Class(LABEL)], ["OpenRouter model id"]),
          h.input([
            h.Class(INPUT),
            h.Value(seat.model),
            h.Placeholder("provider/model"),
            h.Autocomplete("off"),
            h.Spellcheck(false),
            h.OnInput((value) => Message.UpdatedSeatModelId({ seatId, value })),
          ]),
        ],
      ),
    onData: (catalog) => pickerView(model, picker, seat, catalog, h),
  });

  return h.keyed("li")(
    seatId,
    [
      h.Class(
        clsx(
          "space-y-3 rounded-md border-[1.5px] bg-paper p-3",
          errors.length > 0 ? "border-red" : "border-line",
        ),
      ),
    ],
    [
      h.div(
        [h.Class("flex items-center gap-2")],
        [
          seatToken(h, letter, "md"),
          h.span([h.Class("text-sm font-semibold text-ink")], [`Seat ${letter}`]),
          h.button(
            [
              h.Type("button"),
              h.Class(
                "ml-auto rounded px-2 py-1 text-xs font-semibold text-muted hover:bg-red/10 hover:text-red disabled:opacity-30",
              ),
              h.Disabled(!canRemove),
              h.AriaLabel(`Remove seat ${letter}`),
              h.OnClick(Message.ClickedRemoveSeat({ seatId })),
            ],
            ["Remove"],
          ),
        ],
      ),
      seatModelView(h, seat, model.catalog),
      modelInput,
      h.div(
        [h.Class("grid gap-3 sm:grid-cols-2")],
        [
          supportsReasoning
            ? smallSelect(h, "Reasoning effort", seat.reasoning, REASONING_OPTIONS, (value) =>
                Message.SelectedSeatReasoning({ seatId, value }),
              )
            : h.div(
                [],
                [
                  h.span([h.Class(LABEL)], ["Reasoning effort"]),
                  h.p(
                    [h.Class("py-2 text-xs text-muted")],
                    ["This model has no reasoning setting."],
                  ),
                ],
              ),
          h.label(
            [h.Class("block")],
            [
              h.span([h.Class(LABEL)], ["Label"]),
              h.input([
                h.Class(INPUT),
                h.Value(seat.label),
                h.Placeholder("Shown on the leaderboard"),
                h.OnInput((value) => Message.UpdatedSeatLabel({ seatId, value })),
              ]),
            ],
          ),
        ],
      ),
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
    ? Result.match(validateRunForm(model.form, catalogModels(model)), {
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

const catalogNotice = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.match(model.catalog, {
    onIdle: () => h.empty,
    onLoading: () => h.empty,
    onRefreshing: () => h.empty,
    onSuccess: () => h.empty,
    onStale: () => h.empty,
    onFailure: (error) =>
      h.div(
        [
          h.Class(
            "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border-[1.5px] border-red/40 bg-red/5 px-4 py-3 text-sm",
          ),
          h.Role("alert"),
        ],
        [
          h.p(
            [h.Class("text-ink")],
            [
              h.span([h.Class("font-bold text-red")], ["The model catalog did not load. "]),
              `${error}. You can still type OpenRouter ids; the server only accepts models from its catalog.`,
            ],
          ),
          h.button(
            [h.Type("button"), h.Class(BUTTON_SECONDARY), h.OnClick(Message.ClickedRetryCatalog())],
            ["Retry"],
          ),
        ],
      ),
  });

const seatsSection = (model: Model, errors: ReadonlyArray<FieldError>, h: HtmlBuilder<Message>) =>
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
                  `${model.form.seats.length} of ${MAX_SEATS} seats · seat order is the turn order of the first rotation · ≈ = rough cost of one seat in a full 4-player game`,
                ],
              ),
            ],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(BUTTON_SECONDARY),
              h.Disabled(model.form.seats.length >= MAX_SEATS),
              h.OnClick(Message.ClickedAddSeat()),
            ],
            ["+ Seat"],
          ),
        ],
      ),
      catalogNotice(model, h),
      h.ol(
        [h.Class("grid gap-3 md:grid-cols-2")],
        model.form.seats.flatMap((seat, index) => {
          const picker = model.pickers[index];

          return picker === undefined
            ? []
            : [seatCard(model, seat, picker, index, errorsFor(errors, `seat-${index}`), h)];
        }),
      ),
      fieldErrors(h, errorsFor(errors, "seats")),
    ],
  );

const gamesSection = (model: Model, errors: ReadonlyArray<FieldError>, h: HtmlBuilder<Message>) => {
  const games = gamesCount(model.form);

  return h.section(
    [h.Class("deed grid gap-4 p-5 md:grid-cols-3")],
    [
      h.div([h.Class("md:col-span-3")], [h.h2([h.Class("display text-xl text-ink")], ["Games"])]),
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
        placeholder: "1",
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
        placeholder: "50",
        hint: "Hard cap: no new model calls once reached; running games abort.",
        errors: errorsFor(errors, "budgetUsd"),
        onInput: (value) => Message.UpdatedBudget({ value }),
      }),
    ],
  );
};

/** The live total: Σ seat estimates × games, with the budget as the hard cap. */
const estimateView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(catalogModels(model), {
    onNone: () => h.empty,
    onSome: (catalog) => {
      const estimate = estimateRunCost(model.form, catalog);
      const budget = budgetOf(model.form);
      const isOverBudget = Option.exists(budget, (amount) => estimate.totalUsd > amount);

      return h.section(
        [h.Class("banknote grid gap-3 p-5 md:grid-cols-[auto_1fr] md:items-center md:gap-6")],
        [
          h.div(
            [],
            [
              h.p([h.Class("deed-kicker text-money")], ["Estimated cost"]),
              h.p(
                [h.Class("num mt-1 text-3xl font-bold text-ink"), h.AriaLive("polite")],
                [`≈ ${usd(estimate.totalUsd)}`],
              ),
              h.p(
                [h.Class("num text-xs text-ink-2")],
                [
                  `${usd(estimate.perGameUsd)} per game (all seats) × ${integer(estimate.games)} games`,
                ],
              ),
            ],
          ),
          h.div(
            [h.Class("space-y-1.5 text-xs text-ink-2")],
            [
              h.p(
                [],
                [
                  "A rough estimate: the sum of each seat's per-game estimate × games (seeds × seats; every seat plays every game). Real games run shorter or longer and reasoning effort changes output. ",
                  h.a(
                    [h.Href(`${aboutRouter()}#costs`), h.Class("font-semibold text-ink underline")],
                    ["How we estimate"],
                  ),
                ],
              ),
              h.p(
                [h.Class("font-semibold text-ink")],
                [
                  Option.match(budget, {
                    onNone: () => "The budget is the hard cap on what the run can spend.",
                    onSome: (amount) =>
                      `The budget (${usd(amount)}) is the hard cap: no new model calls once it is reached.`,
                  }),
                ],
              ),
              isOverBudget
                ? h.p(
                    [h.Class("font-semibold text-[#9a5300]"), h.Role("status")],
                    [
                      "The estimate is above the budget: the run will probably stop before every game finishes.",
                    ],
                  )
                : h.empty,
              estimate.unpricedSeats > 0
                ? h.p(
                    [],
                    [
                      `${estimate.unpricedSeats} seat${estimate.unpricedSeats === 1 ? " has" : "s have"} no OpenRouter price and ${estimate.unpricedSeats === 1 ? "is" : "are"} not counted.`,
                    ],
                  )
                : h.empty,
            ],
          ),
        ],
      );
    },
  });

const fundingOption = (
  model: Model,
  funding: RunFunding,
  title: string,
  body: string,
  h: HtmlBuilder<Message>,
): Html => {
  const isChecked = model.form.funding === funding;

  return h.label(
    [
      h.Class(
        clsx(
          "flex cursor-pointer items-start gap-3 rounded-md border-[1.5px] bg-paper p-3 transition",
          isChecked
            ? "border-line-strong shadow-[3px_3px_0_var(--shadow)]"
            : "border-line hover:border-ink-2",
        ),
      ),
    ],
    [
      h.input([
        h.Type("radio"),
        h.Name("run-funding"),
        h.AriaLabel(title),
        h.Value(funding),
        h.Checked(isChecked),
        h.Class("mt-1 accent-[var(--red)]"),
        h.OnChange((value) => Message.SelectedFunding({ value })),
      ]),
      h.span(
        [],
        [
          h.span([h.Class("block font-semibold text-ink")], [title]),
          h.span([h.Class("block text-xs text-ink-2")], [body]),
        ],
      ),
    ],
  );
};

const fundingSection = (
  model: Model,
  errors: ReadonlyArray<FieldError>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class("deed space-y-4 p-5")],
    [
      h.div(
        [],
        [
          h.h2([h.Class("display text-xl text-ink")], ["Who pays"]),
          h.p(
            [h.Class("text-xs text-muted")],
            ["Model calls go through OpenRouter. Pick whose account they are billed to."],
          ),
        ],
      ),
      h.div(
        [h.Class("grid gap-3 md:grid-cols-2"), h.Role("radiogroup"), h.AriaLabel("Who pays")],
        [
          fundingOption(
            model,
            "ownKey",
            "My OpenRouter key",
            "Your OpenRouter account pays for this run's model calls.",
            h,
          ),
          fundingOption(
            model,
            "server",
            "Bench API key",
            "Server credit, for whoever holds the bench API key.",
            h,
          ),
        ],
      ),
      model.form.funding === "ownKey"
        ? textField(h, {
            id: "run-openrouter-key",
            label: "OpenRouter API key",
            value: model.form.openRouterKey,
            placeholder: "sk-or-v1-…",
            type: "password",
            isSecret: true,
            hint: "Sent once with this request (x-openrouter-key header) and used only for this run: the server keeps it while the run is active and discards it when the run ends. This page never saves it.",
            errors: errorsFor(errors, "openRouterKey"),
            onInput: (value) => Message.UpdatedOpenRouterKey({ value }),
          })
        : h.div(
            [h.Class("grid gap-3 md:grid-cols-[1fr_auto] md:items-end")],
            [
              textField(h, {
                id: "run-api-key",
                label: "Bench API key",
                value: model.form.apiKey,
                placeholder: "BENCH_API_KEY",
                type: "password",
                isSecret: true,
                hint: "Kept in this browser (localStorage) and sent as an Authorization: Bearer header. Also cancels server-paid runs.",
                errors: errorsFor(errors, "apiKey"),
                onInput: (value) => Message.UpdatedApiKey({ value }),
              }),
              model.form.apiKey === ""
                ? h.empty
                : h.button(
                    [
                      h.Type("button"),
                      h.Class(clsx(BUTTON_GHOST, "mb-6 text-xs underline")),
                      h.OnClick(Message.ClickedForgetApiKey()),
                    ],
                    ["Forget key"],
                  ),
            ],
          ),
    ],
  );

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const errors = formErrors(model);
  const games = gamesCount(model.form);

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
              "Pick 2–6 models from OpenRouter's catalog. A run plays every seed once per seat rotation, so each model sits in every chair with the same dice and decks, and the results feed the public leaderboard. Pay with your own OpenRouter key, or with server credit if you hold the bench API key. ",
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
          seatsSection(model, errors, h),
          gamesSection(model, errors, h),
          estimateView(model, h),
          fundingSection(model, errors, h),
          h.div(
            [h.Class("flex flex-wrap items-center gap-4")],
            [
              submitButton(model, h),
              h.p(
                [h.Class("text-sm text-ink-2")],
                [
                  `${integer(games)} games · ${model.form.seats.length} seats · ${model.form.funding === "ownKey" ? "paid with your OpenRouter key" : "paid with server credit"}`,
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
