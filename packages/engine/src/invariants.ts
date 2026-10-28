/** Invariants of SPEC §4.1, checked by tests after every event (kept cheap on purpose). */
import { GROUP_IDS } from "./data/ids.ts";
import { groupMembers, PROPERTIES } from "./data/board.ts";
import { DECK_SIZE, jailCardIndex } from "./data/cards.ts";
import { hotelsAt, housesAt } from "./rules.ts";

import type { DeckId, Seat } from "./schema/common.ts";
import type { GameState } from "./schema/state.ts";

/** Deed indexes of each group, precomputed once. */
const GROUP_INDEXES: ReadonlyArray<ReadonlyArray<number>> = GROUP_IDS.map((group) =>
  groupMembers(group).map((id) => PROPERTIES.findIndex((info) => info.id === id)),
);

const GROUP_OF: ReadonlyArray<number> = PROPERTIES.map((info) => GROUP_IDS.indexOf(info.group));

const JAIL_CARD: Readonly<Record<DeckId, number>> = {
  chance: jailCardIndex("chance"),
  communityChest: jailCardIndex("communityChest"),
};

const checkDeck = (
  state: GameState,
  deck: DeckId,
  order: ReadonlyArray<number>,
  problems: Array<string>,
): void => {
  const seen = Array.from({ length: DECK_SIZE }, () => 0);
  let count = order.length;

  for (const card of order) seen[card] = (seen[card] ?? 0) + 1;

  for (const current of state.players) {
    for (const held of current.jailCards) {
      if (held !== deck) continue;

      const card = JAIL_CARD[deck];

      seen[card] = (seen[card] ?? 0) + 1;
      count += 1;
    }
  }

  const unshuffled = state.status === "setup" && count === 0;

  if (!unshuffled && (count !== DECK_SIZE || seen.some((times) => times !== 1))) {
    problems.push(`${deck}: deck is not a permutation`);
  }
};

/**
 * Returns a description of every broken invariant (empty when the state is sound):
 * building supply conservation, deeds owned only by active players, even building,
 * buildings only on complete unmortgaged sets, no negative cash, bankrupt players own
 * nothing, decks plus held jail cards are permutations, drafts belong to open frames.
 */
export const checkInvariants = (state: GameState): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const rules = state.config.rules;
  const bankrupt = new Set<Seat>();
  let houses = state.bank.houses;
  let hotels = state.bank.hotels;

  for (const current of state.players) {
    if (current.bankrupt) bankrupt.add(current.seat);

    if (!Number.isInteger(current.cash) || current.cash < 0) {
      problems.push(`${current.seat}: cash ${current.cash}`);
    }

    if (current.bankrupt && (current.cash !== 0 || current.jailCards.length > 0)) {
      problems.push(`${current.seat}: bankrupt with assets`);
    }
  }

  for (let index = 0; index < state.properties.length; index += 1) {
    const property = state.properties[index];
    const info = PROPERTIES[index];

    if (property === undefined || info === undefined) continue;

    houses += housesAt(property.level);
    hotels += hotelsAt(property.level);

    if (property.owner === null) {
      if (property.mortgaged || property.level > 0) problems.push(`${info.id}: bank deed altered`);

      continue;
    }

    if (bankrupt.has(property.owner))
      problems.push(`${info.id}: owned by bankrupt ${property.owner}`);

    if (property.level === 0) continue;

    if (info.kind !== "street") problems.push(`${info.id}: buildings off-street`);

    for (const sibling of GROUP_INDEXES[GROUP_OF[index] ?? 0] ?? []) {
      const other = state.properties[sibling];

      if (other === undefined) continue;

      if (other.owner !== property.owner)
        problems.push(`${info.id}: buildings on an incomplete set`);

      if (other.mortgaged) problems.push(`${info.id}: buildings on a mortgaged set`);

      if (Math.abs(other.level - property.level) > 1) problems.push(`${info.id}: uneven building`);
    }
  }

  if (houses !== rules.houses) problems.push(`houses: ${houses} instead of ${rules.houses}`);

  if (hotels !== rules.hotels) problems.push(`hotels: ${hotels} instead of ${rules.hotels}`);

  checkDeck(state, "chance", state.decks.chance, problems);
  checkDeck(state, "communityChest", state.decks.communityChest, problems);

  if (state.drafts.length > 0) {
    const frames = new Set(state.control.stack.map((frame) => frame.id));

    if (state.drafts.some((draft) => !frames.has(draft.frame))) {
      problems.push("draft of a closed frame");
    }
  }

  return problems;
};
