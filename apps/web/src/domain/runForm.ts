/**
 * The start-a-run form: its state, validation into a `RunConfig` plus who pays, the model
 * catalog search, and the run cost estimate (all pure).
 */
import {
  LlmSeat,
  Reasoning,
  RunConfig,
  RunFunding,
  TableFrequency,
  featuredModels,
  type ModelCatalogEntry,
} from "@mb/api";
import { Option, Result, Schema } from "effect";

import { RunPayment } from "../api/api.ts";

/** One seat of the run: an OpenRouter model, its leaderboard label and reasoning effort. */
export const SeatDraft = Schema.Struct({
  model: Schema.String,
  label: Schema.String,
  reasoning: Reasoning,
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
  /** Who pays: the creator's OpenRouter key (`ownKey`) or the server (`server`, bench key). */
  funding: RunFunding,
  /** The creator's OpenRouter key: kept in memory only, sent once with the create request. */
  openRouterKey: Schema.String,
  /** The bench API key (remembered in localStorage). */
  apiKey: Schema.String,
});

export type RunForm = typeof RunForm.Type;

export const MIN_SEATS = 2;

export const MAX_SEATS = 6;

/** Featured models seated by default: a cheap, varied first table (Haiku, DeepSeek, Kimi, GLM). */
const DEFAULT_SEAT_PICKS: ReadonlyArray<number> = [2, 7, 9, 10];

/** A validation problem, attached to a form field (`seat-<index>` for seats). */
export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/** A valid form: the run to create and who pays for it. */
export interface ValidRun {
  readonly config: RunConfig;
  readonly payment: RunPayment;
}

const MODEL_ID = /^~?[a-z0-9][\w.-]*\/[\w.:-]+$/i;

export const seatFor = (entry: ModelCatalogEntry): SeatDraft => ({
  model: entry.model,
  label: entry.label,
  reasoning: "off",
});

/**
 * Default seats before the catalog arrives: featured ids with no label yet. `withCatalog` names
 * them (or swaps ids the catalog no longer lists) once it loads.
 */
export const defaultSeats = (): ReadonlyArray<SeatDraft> =>
  DEFAULT_SEAT_PICKS.flatMap((pick) => {
    const model = featuredModels[pick];

    return model === undefined ? [] : [{ model, label: "", reasoning: "off" as const }];
  });

export const defaultForm = (apiKey: string): RunForm => ({
  name: "",
  seats: defaultSeats(),
  seeds: "1",
  maxRounds: "",
  tableFrequency: "everyTurn",
  concurrency: "2",
  budgetUsd: "50",
  funding: apiKey === "" ? "ownKey" : "server",
  openRouterKey: "",
  apiKey,
});

export const findModel = (
  catalog: ReadonlyArray<ModelCatalogEntry>,
  model: string,
): ModelCatalogEntry | undefined => catalog.find((entry) => entry.model === model);

/** Models shown first, then every provider's models: the catalog in picker order. */
export const orderCatalog = (
  catalog: ReadonlyArray<ModelCatalogEntry>,
): ReadonlyArray<ModelCatalogEntry> => {
  const featuredRank = (entry: ModelCatalogEntry): number => {
    const rank = featuredModels.indexOf(entry.model);

    return rank < 0 ? featuredModels.length : rank;
  };

  return [...catalog].sort((left, right) => {
    if (left.featured !== right.featured) return left.featured ? -1 : 1;

    if (left.featured) return featuredRank(left) - featuredRank(right);

    return (
      left.provider.localeCompare(right.provider) ||
      left.providerSlug.localeCompare(right.providerSlug) ||
      left.label.localeCompare(right.label)
    );
  });
};

/** Catalog entries matching every word of `query` in their name, provider or id. */
export const searchCatalog = (
  ordered: ReadonlyArray<ModelCatalogEntry>,
  query: string,
): ReadonlyArray<ModelCatalogEntry> => {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  if (terms.length === 0) return ordered;

  return ordered.filter((entry) => {
    const haystack =
      `${entry.label} ${entry.provider} ${entry.providerSlug} ${entry.model}`.toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });
};

/**
 * Fills the seats once the catalog loads: unnamed default seats take the catalog label, and a
 * default id the catalog no longer lists is replaced by a featured model not seated yet.
 */
export const withCatalog = (
  seats: ReadonlyArray<SeatDraft>,
  catalog: ReadonlyArray<ModelCatalogEntry>,
): ReadonlyArray<SeatDraft> => {
  const spare = orderCatalog(catalog).filter(
    (entry) => !seats.some((seat) => seat.model === entry.model),
  );

  const missing = seats.flatMap((seat, index) =>
    seat.label === "" && findModel(catalog, seat.model) === undefined ? [index] : [],
  );

  return seats.map((seat, index) => {
    if (seat.label !== "") return seat;

    const entry = findModel(catalog, seat.model) ?? spare[missing.indexOf(index)];

    return entry === undefined ? seat : seatFor(entry);
  });
};

/** The seat after picking `entry`: its label follows the model; reasoning only if supported. */
export const pickModel = (seat: SeatDraft, entry: ModelCatalogEntry): SeatDraft => ({
  model: entry.model,
  label: entry.label,
  reasoning: entry.reasoning ? seat.reasoning : "off",
});

const parseInteger = (text: string): Option.Option<number> => {
  const trimmed = text.trim();

  return /^\d+$/.test(trimmed) ? Option.some(Number.parseInt(trimmed, 10)) : Option.none();
};

const parseAmount = (text: string): Option.Option<number> => {
  const trimmed = text.trim().replace(/^\$/, "");

  return /^\d+(\.\d+)?$/.test(trimmed) ? Option.some(Number.parseFloat(trimmed)) : Option.none();
};

const inRange = (value: number, min: number, max: number): boolean => value >= min && value <= max;

const seatSpec = (draft: SeatDraft): LlmSeat =>
  draft.reasoning === "off"
    ? LlmSeat.make({ model: draft.model.trim(), label: draft.label.trim() })
    : LlmSeat.make({
        model: draft.model.trim(),
        label: draft.label.trim(),
        reasoning: draft.reasoning,
      });

/**
 * Problems of one seat. With the catalog loaded the model must be one of its entries (the server
 * rejects anything else); without it, any well-formed OpenRouter id is accepted.
 */
const seatErrors = (
  draft: SeatDraft,
  index: number,
  catalog: Option.Option<ReadonlyArray<ModelCatalogEntry>>,
): ReadonlyArray<FieldError> => {
  const field = `seat-${index}`;
  const model = draft.model.trim();

  const modelErrors = (): ReadonlyArray<FieldError> => {
    if (model === "") return [{ field, message: "Choose a model." }];

    return Option.match(catalog, {
      onNone: () =>
        MODEL_ID.test(model)
          ? []
          : [
              {
                field,
                message:
                  "OpenRouter ids look like provider/model, e.g. anthropic/claude-sonnet-5.5.",
              },
            ],
      onSome: (entries) =>
        findModel(entries, model) === undefined
          ? [{ field, message: `${model} is not in the model catalog: choose another model.` }]
          : [],
    });
  };

  return [
    ...modelErrors(),
    ...(draft.label.trim() === "" ? [{ field, message: "Give this seat a label." }] : []),
  ];
};

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

const paymentOf = (form: RunForm): Result.Result<RunPayment, FieldError> => {
  if (form.funding === "ownKey") {
    const openRouterKey = form.openRouterKey.trim();

    return openRouterKey === ""
      ? Result.fail({ field: "openRouterKey", message: "Paste your OpenRouter API key." })
      : Result.succeed(RunPayment.OwnKey({ openRouterKey }));
  }

  const apiKey = form.apiKey.trim();

  return apiKey === ""
    ? Result.fail({ field: "apiKey", message: "Server-paid runs need the bench API key." })
    : Result.succeed(RunPayment.BenchKey({ apiKey }));
};

const decodeRunConfig = Schema.decodeUnknownResult(RunConfig);

/**
 * Validates the form into a `RunConfig` (checked against the API schema) and who pays, or lists
 * every problem. `catalog` is the loaded model catalog, if any.
 */
export const validateRunForm = (
  form: RunForm,
  catalog: Option.Option<ReadonlyArray<ModelCatalogEntry>>,
): Result.Result<ValidRun, ReadonlyArray<FieldError>> => {
  const errors: Array<FieldError> = [];

  if (form.seats.length < MIN_SEATS || form.seats.length > MAX_SEATS) {
    errors.push({ field: "seats", message: `A game needs ${MIN_SEATS} to ${MAX_SEATS} seats.` });
  }

  form.seats.forEach((draft, index) => errors.push(...seatErrors(draft, index, catalog)));

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

  const payment = paymentOf(form);

  if (Result.isFailure(payment)) errors.push(payment.failure);

  if (
    errors.length > 0 ||
    Option.isNone(seeds) ||
    Option.isNone(budget) ||
    Result.isFailure(maxRounds) ||
    Result.isFailure(concurrency) ||
    Result.isFailure(payment)
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

  return Result.match(decodeRunConfig(candidate), {
    onFailure: (error) => Result.fail([{ field: "form", message: error.message }]),
    onSuccess: (config) => Result.succeed({ config, payment: payment.success }),
  });
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

/** The rough cost of a run, from the catalog's per-seat estimates. */
export interface RunCostEstimate {
  /** One game: the sum of every seat's estimate (each seat plays every game). */
  readonly perGameUsd: number;
  readonly games: number;
  readonly totalUsd: number;
  /** Seats whose model has no price in the catalog (not counted). */
  readonly unpricedSeats: number;
}

/**
 * Σ over seats of `estimatedSeatCostUsd` × games, where games = seeds × players and each seat
 * plays every game. A rough figure (`seatCostModel` in `@mb/api`); the budget is the hard cap.
 */
export const estimateRunCost = (
  form: RunForm,
  catalog: ReadonlyArray<ModelCatalogEntry>,
): RunCostEstimate => {
  const seatCosts = form.seats.map(
    (seat) => findModel(catalog, seat.model)?.estimatedSeatCostUsd ?? null,
  );

  const perGameUsd = seatCosts.reduce<number>((total, cost) => total + (cost ?? 0), 0);
  const games = gamesCount(form);

  return {
    perGameUsd,
    games,
    totalUsd: perGameUsd * games,
    unpricedSeats: seatCosts.filter((cost) => cost === null).length,
  };
};

/** The budget as typed, if it is a valid amount. */
export const budgetOf = (form: RunForm): Option.Option<number> => parseAmount(form.budgetUsd);
