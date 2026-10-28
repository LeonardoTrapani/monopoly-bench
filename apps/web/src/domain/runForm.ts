/** The start-a-run form: its state and validation into a `RunConfig` (pure). */
import {
  BotPolicy,
  BotSeat,
  LlmSeat,
  Reasoning,
  RunConfig,
  TableFrequency,
  type ModelCatalogEntry,
  type SeatSpec,
} from "@mb/api";
import { Option, Result, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

export const SeatDraft = defineTaggedUnion({
  Llm: {
    model: Schema.String,
    isCustom: Schema.Boolean,
    label: Schema.String,
    reasoning: Reasoning,
  },
  Bot: { policy: BotPolicy },
});

export type SeatDraft = typeof SeatDraft.Type;

export const RunForm = Schema.Struct({
  name: Schema.String,
  seats: Schema.Array(SeatDraft),
  seeds: Schema.String,
  maxRounds: Schema.String,
  tableFrequency: TableFrequency,
  concurrency: Schema.String,
  budgetUsd: Schema.String,
  apiKey: Schema.String,
});

export type RunForm = typeof RunForm.Type;

export const MIN_SEATS = 2;

export const MAX_SEATS = 6;

/** A validation problem, attached to a form field (`seat-<index>` for seats). */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

const MODEL_ID = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

export const llmSeat = (entry: ModelCatalogEntry): SeatDraft =>
  SeatDraft.Llm({ model: entry.model, isCustom: false, label: entry.label, reasoning: "off" });

export const defaultForm = (catalog: ReadonlyArray<ModelCatalogEntry>, apiKey: string): RunForm => {
  const pickModel = (index: number): SeatDraft => {
    const entry = catalog[index];

    return entry === undefined ? SeatDraft.Bot({ policy: "heuristic" }) : llmSeat(entry);
  };

  return {
    name: "",
    seats: [pickModel(1), pickModel(3), pickModel(5), SeatDraft.Bot({ policy: "heuristic" })],
    seeds: "3",
    maxRounds: "",
    tableFrequency: "everyTurn",
    concurrency: "2",
    budgetUsd: "25",
    apiKey,
  };
};

const parseInteger = (text: string): Option.Option<number> => {
  const trimmed = text.trim();

  return /^\d+$/.test(trimmed) ? Option.some(Number.parseInt(trimmed, 10)) : Option.none();
};

const parseAmount = (text: string): Option.Option<number> => {
  const trimmed = text.trim().replace(/^\$/, "");

  return /^\d+(\.\d+)?$/.test(trimmed) ? Option.some(Number.parseFloat(trimmed)) : Option.none();
};

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

const seatSpec = (draft: SeatDraft): SeatSpec =>
  SeatDraft.match(draft, {
    Llm: (llm) =>
      llm.reasoning === "off"
        ? LlmSeat.make({ model: llm.model.trim(), label: llm.label.trim() })
        : LlmSeat.make({
            model: llm.model.trim(),
            label: llm.label.trim(),
            reasoning: llm.reasoning,
          }),
    Bot: (bot) => BotSeat.make({ policy: bot.policy }),
  });

const seatErrors = (draft: SeatDraft, index: number): ReadonlyArray<FieldError> =>
  SeatDraft.match(draft, {
    Llm: (llm) => [
      ...(llm.model.trim() === ""
        ? [{ field: `seat-${index}`, message: "Choose a model or type an OpenRouter id." }]
        : MODEL_ID.test(llm.model.trim())
          ? []
          : [
              {
                field: `seat-${index}`,
                message:
                  "OpenRouter ids look like provider/model, e.g. anthropic/claude-sonnet-5.5.",
              },
            ]),
      ...(llm.label.trim() === ""
        ? [{ field: `seat-${index}`, message: "Give this seat a label." }]
        : []),
    ],
    Bot: () => [],
  });

const optionalInteger = (
  text: string,
  field: string,
  min: number,
  max: number,
  message: string,
): Result.Result<Option.Option<number>, FieldError> => {
  if (text.trim() === "") return Result.succeed(Option.none());

  return Option.match(
    Option.filter(parseInteger(text), (value) => inRange(value, min, max)),
    {
      onNone: () => Result.fail({ field, message }),
      onSome: (value) => Result.succeed(Option.some(value)),
    },
  );
};

const decodeRunConfig = Schema.decodeUnknownResult(RunConfig);

/** Validates the form into a `RunConfig` (checked against the API schema), or lists every problem. */
export const validateRunForm = (
  form: RunForm,
): Result.Result<RunConfig, ReadonlyArray<FieldError>> => {
  const errors: Array<FieldError> = [];

  if (form.seats.length < MIN_SEATS || form.seats.length > MAX_SEATS) {
    errors.push({ field: "seats", message: `A game needs ${MIN_SEATS} to ${MAX_SEATS} seats.` });
  }

  form.seats.forEach((draft, index) => errors.push(...seatErrors(draft, index)));

  const seeds = Option.filter(parseInteger(form.seeds), (value) => inRange(value, 1, 200));

  if (Option.isNone(seeds))
    errors.push({ field: "seeds", message: "Seeds must be a whole number from 1 to 200." });

  const maxRounds = optionalInteger(
    form.maxRounds,
    "maxRounds",
    1,
    1000,
    "Max rounds must be a whole number from 1 to 1000, or empty.",
  );

  if (Result.isFailure(maxRounds)) errors.push(maxRounds.failure);

  const concurrency = optionalInteger(
    form.concurrency,
    "concurrency",
    1,
    16,
    "Concurrency must be a whole number from 1 to 16, or empty.",
  );

  if (Result.isFailure(concurrency)) errors.push(concurrency.failure);

  const budget = Option.filter(parseAmount(form.budgetUsd), (value) => inRange(value, 0, 10_000));

  if (Option.isNone(budget))
    errors.push({
      field: "budgetUsd",
      message: "Budget must be an amount in USD from 0 to 10,000.",
    });

  if (form.apiKey.trim() === "")
    errors.push({ field: "apiKey", message: "Starting a run needs the bench API key." });

  if (
    errors.length > 0 ||
    Option.isNone(seeds) ||
    Option.isNone(budget) ||
    Result.isFailure(maxRounds) ||
    Result.isFailure(concurrency)
  ) {
    return Result.fail(errors);
  }

  const name = form.name.trim();

  const base = {
    players: form.seats.map(seatSpec),
    seeds: seeds.value,
    tableFrequency: form.tableFrequency,
    budgetUsd: budget.value,
  };

  const named = name === "" ? base : { ...base, name };

  const capped = Option.match(maxRounds.success, {
    onNone: () => named,
    onSome: (value) => ({ ...named, maxRounds: value }),
  });

  const candidate = Option.match(concurrency.success, {
    onNone: () => capped,
    onSome: (value) => ({ ...capped, concurrency: value }),
  });

  return Result.mapError(decodeRunConfig(candidate), (error) => [
    { field: "form", message: error.message },
  ]);
};

/** Problems for one field (empty when valid). */
export const errorsFor = (
  errors: ReadonlyArray<FieldError>,
  field: string,
): ReadonlyArray<string> =>
  errors.flatMap((error) => (error.field === field ? [error.message] : []));

/** Games a run will play: seeds × seats (every seat rotation of every seed). */
export const gamesCount = (form: RunForm): number =>
  Option.getOrElse(parseInteger(form.seeds), () => 0) * form.seats.length;
