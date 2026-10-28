/**
 * Chance (US, 2008+) and Community Chest (US, October 2021) decks. Community Chest
 * keeps the 2021 flavour texts verbatim; its effects are the same as the 2008 deck
 * (SPEC §3.2).
 */
import { Predicate, Schema } from "effect";

import { Money, Position } from "../schema/common.ts";

import type { DeckId } from "./ids.ts";

export const CardEffect = Schema.TaggedUnion({
  /** Move forward to `position`, collecting GO salary when passing GO. */
  AdvanceTo: { position: Position },
  /** Move forward to the nearest railroad (pay twice the rent) or utility (10× a fresh roll). */
  AdvanceToNearest: { kind: Schema.Literals(["railroad", "utility"]) },
  Collect: { amount: Money },
  Pay: { amount: Money },
  GetOutOfJailFree: {},
  GoBack: { spaces: Schema.Int },
  GoToJail: {},
  Repairs: { perHouse: Money, perHotel: Money },
  PayEachPlayer: { amount: Money },
  CollectFromEachPlayer: { amount: Money },
});

export type CardEffect = typeof CardEffect.Type;

export interface Card {
  readonly deck: DeckId;
  /** Position of the card in the printed deck; events refer to cards by `(deck, index)`. */
  readonly index: number;
  readonly text: string;
  readonly effect: CardEffect;
}

const E = CardEffect.cases;

const chance: ReadonlyArray<readonly [string, CardEffect]> = [
  ["Advance to Boardwalk.", E.AdvanceTo.make({ position: 39 })],
  ["Advance to Go (Collect $200).", E.AdvanceTo.make({ position: 0 })],
  ["Advance to Illinois Avenue. If you pass Go, collect $200.", E.AdvanceTo.make({ position: 24 })],
  [
    "Advance to St. Charles Place. If you pass Go, collect $200.",
    E.AdvanceTo.make({ position: 11 }),
  ],
  [
    "Advance to the nearest Railroad. If unowned, you may buy it from the Bank. If owned, pay owner twice the rental to which they are otherwise entitled.",
    E.AdvanceToNearest.make({ kind: "railroad" }),
  ],
  [
    "Advance to the nearest Railroad. If unowned, you may buy it from the Bank. If owned, pay owner twice the rental to which they are otherwise entitled.",
    E.AdvanceToNearest.make({ kind: "railroad" }),
  ],
  [
    "Advance token to nearest Utility. If unowned, you may buy it from the Bank. If owned, throw dice and pay owner a total ten times amount thrown.",
    E.AdvanceToNearest.make({ kind: "utility" }),
  ],
  ["Bank pays you dividend of $50.", E.Collect.make({ amount: 50 })],
  [
    "Get Out of Jail Free. This card may be kept until needed, traded, or sold.",
    E.GetOutOfJailFree.make({}),
  ],
  ["Go Back 3 Spaces.", E.GoBack.make({ spaces: 3 })],
  ["Go to Jail. Go directly to Jail, do not pass Go, do not collect $200.", E.GoToJail.make({})],
  [
    "Make general repairs on all your property. For each house pay $25. For each hotel pay $100.",
    E.Repairs.make({ perHouse: 25, perHotel: 100 }),
  ],
  ["Speeding fine $15.", E.Pay.make({ amount: 15 })],
  [
    "Take a trip to Reading Railroad. If you pass Go, collect $200.",
    E.AdvanceTo.make({ position: 5 }),
  ],
  [
    "You have been elected Chairman of the Board. Pay each player $50.",
    E.PayEachPlayer.make({ amount: 50 }),
  ],
  ["Your building loan matures. Collect $150.", E.Collect.make({ amount: 150 })],
];

const communityChest: ReadonlyArray<readonly [string, CardEffect]> = [
  [
    "You set aside time every week to hang out with your elderly neighbor – you’ve heard some amazing stories! COLLECT $100.",
    E.Collect.make({ amount: 100 }),
  ],
  [
    "You organize a group to clean up your town’s footpaths. COLLECT $50.",
    E.Collect.make({ amount: 50 }),
  ],
  [
    "You volunteered at a blood donation. There were free cookies! COLLECT $10.",
    E.Collect.make({ amount: 10 }),
  ],
  [
    "You buy a few bags of cookies from that school bake sale. Yum! PAY $50.",
    E.Pay.make({ amount: 50 }),
  ],
  [
    "You rescue a puppy – and you feel rescued, too! GET OUT OF JAIL FREE. Keep this card until needed, traded, or sold.",
    E.GetOutOfJailFree.make({}),
  ],
  [
    "You organize a street party so people on your road can get to know each other. COLLECT $10 FROM EACH PLAYER.",
    E.CollectFromEachPlayer.make({ amount: 10 }),
  ],
  [
    "Blasting music late at night? Your neighbors do not approve. GO TO JAIL. DO NOT PASS GO. DO NOT COLLECT $200.",
    E.GoToJail.make({}),
  ],
  [
    "You help your neighbor bring in her groceries. She makes you lunch to say thanks! COLLECT $20.",
    E.Collect.make({ amount: 20 }),
  ],
  [
    "You help build a new school playground – then you get to test the slide! COLLECT $100.",
    E.Collect.make({ amount: 100 }),
  ],
  [
    "You spend the day playing games with kids at a local children’s hospital. COLLECT $100.",
    E.Collect.make({ amount: 100 }),
  ],
  [
    "You go to the local school’s car wash fundraiser – but you forget to close your windows! PAY $100.",
    E.Pay.make({ amount: 100 }),
  ],
  [
    "Just when you think you can’t go another step, you finish that foot race – and raise money for your local hospital! ADVANCE TO GO. (COLLECT $200)",
    E.AdvanceTo.make({ position: 0 }),
  ],
  [
    "You help your neighbors clean up their Gardens after a big storm. COLLECT $200.",
    E.Collect.make({ amount: 200 }),
  ],
  [
    "Your fuzzy friends at the animal shelter will be thankful for your donation. PAY $50.",
    E.Pay.make({ amount: 50 }),
  ],
  [
    "You should have volunteered for that home improvement project – you would have learned valuable skills! FOR EACH HOUSE YOU OWN, PAY $40. FOR EACH HOTEL YOU OWN, PAY $115.",
    E.Repairs.make({ perHouse: 40, perHotel: 115 }),
  ],
  ["You organize a bake sale for your local school. COLLECT $25.", E.Collect.make({ amount: 25 })],
];

const toCards = (deck: DeckId, entries: ReadonlyArray<readonly [string, CardEffect]>) =>
  entries.map(([text, effect], index): Card => ({ deck, index, text, effect }));

export const CHANCE_CARDS: ReadonlyArray<Card> = toCards("chance", chance);

export const COMMUNITY_CHEST_CARDS: ReadonlyArray<Card> = toCards("communityChest", communityChest);

export const DECK_SIZE = 16;

export const deckCards = (deck: DeckId): ReadonlyArray<Card> =>
  deck === "chance" ? CHANCE_CARDS : COMMUNITY_CHEST_CARDS;

export const cardAt = (deck: DeckId, index: number): Card => {
  const card = deckCards(deck)[index];

  if (card === undefined) throw new Error(`No card ${index} in ${deck}`);

  return card;
};

/** Index of the Get Out of Jail Free card in each printed deck. */
export const jailCardIndex = (deck: DeckId): number =>
  deckCards(deck).findIndex((card) => Predicate.isTagged(card.effect, "GetOutOfJailFree"));

export const DECK_NAMES: Readonly<Record<DeckId, string>> = {
  chance: "Chance",
  communityChest: "Community Chest",
};
