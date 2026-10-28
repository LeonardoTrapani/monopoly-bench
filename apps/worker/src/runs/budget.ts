/**
 * Budget accounting of a run (SPEC.md §8). The budget gates LLM wakes: once
 * `spentUsd ≥ budgetUsd`, no new wake may start and games that need LLM wakes are aborted.
 * Bot-only games cost nothing and are never stopped by the budget.
 *
 * Charges are keyed (one key per wake) so a retried report never charges twice.
 */
export interface Budget {
  readonly budgetUsd: number;
  readonly spentUsd: number;
}

export const isExhausted = (budget: Budget): boolean => budget.spentUsd >= budget.budgetUsd;

/** Whether a game may still start (or dispatch a wake). */
export const mayRun = (budget: Budget, needsLlm: boolean): boolean =>
  !needsLlm || !isExhausted(budget);

export interface ChargeOutcome {
  readonly budget: Budget;
  /** The charge was new (not a duplicate key). */
  readonly applied: boolean;
  /** This charge moved the run from under budget to exhausted. */
  readonly crossed: boolean;
}

export const charge = (budget: Budget, alreadyCharged: boolean, costUsd: number): ChargeOutcome => {
  if (alreadyCharged || costUsd <= 0) return { budget, applied: !alreadyCharged, crossed: false };

  const next = { ...budget, spentUsd: budget.spentUsd + costUsd };

  return { budget: next, applied: true, crossed: !isExhausted(budget) && isExhausted(next) };
};
