/** Title deeds: the full card (rent table) and the small chip used in player panels and offers. */
import { propertyInfo, type PropertyId, type PropertyState } from "@mb/engine";
import clsx from "clsx";
import type { Html, HtmlBuilder } from "foldkit/html";

import { money } from "../domain/format.ts";
import { GROUP_COLORS, GROUP_INK } from "../domain/palette.ts";

const rentRow = <M>(h: HtmlBuilder<M>, label: string, value: string): Html =>
  h.div(
    [h.Class("flex justify-between gap-3")],
    [h.span([], [label]), h.span([h.Class("num")], [value])],
  );

/** A title-deed card with its printed rents. */
export const deedCardView = <M>(
  h: HtmlBuilder<M>,
  property: PropertyId,
  footer: Html = null,
): Html => {
  const info = propertyInfo(property);
  const isStreet = info.kind === "street";

  const rows: ReadonlyArray<Html> = isStreet
    ? [
        rentRow(h, "Rent", money(info.rents[0] ?? 0)),
        rentRow(h, "With 1 house", money(info.rents[1] ?? 0)),
        rentRow(h, "With 2 houses", money(info.rents[2] ?? 0)),
        rentRow(h, "With 3 houses", money(info.rents[3] ?? 0)),
        rentRow(h, "With 4 houses", money(info.rents[4] ?? 0)),
        rentRow(h, "With hotel", money(info.rents[5] ?? 0)),
        h.div([h.Class("my-1 border-t border-line")]),
        rentRow(h, "Houses cost", `${money(info.houseCost)} each`),
      ]
    : info.kind === "railroad"
      ? [
          rentRow(h, "Rent", money(25)),
          rentRow(h, "If 2 railroads owned", money(50)),
          rentRow(h, "If 3 railroads owned", money(100)),
          rentRow(h, "If 4 railroads owned", money(200)),
        ]
      : [
          h.p(
            [h.Class("text-[11px] leading-snug")],
            ["If one utility is owned, rent is 4× the dice roll."],
          ),
          h.p(
            [h.Class("text-[11px] leading-snug")],
            ["If both are owned, rent is 10× the dice roll."],
          ),
        ];

  return h.div(
    [h.Class("deed w-full max-w-[15rem] bg-paper text-ink")],
    [
      h.div(
        [
          h.Class("deed-head"),
          h.Style({ background: GROUP_COLORS[info.group], color: GROUP_INK[info.group] }),
        ],
        [
          h.p(
            [h.Class("deed-kicker opacity-80")],
            [isStreet ? "Title deed" : info.kind === "railroad" ? "Railroad" : "Utility"],
          ),
          h.p([h.Class("display text-sm leading-tight uppercase")], [info.name]),
        ],
      ),
      h.div(
        [h.Class("space-y-0.5 px-3 py-2 text-xs text-ink-2")],
        [
          ...rows,
          h.div([h.Class("my-1 border-t border-line")]),
          rentRow(h, "Price", money(info.price)),
          rentRow(h, "Mortgage value", money(info.mortgage)),
          footer,
        ],
      ),
    ],
  );
};

const levelText = (level: number): string => {
  if (level === 5) return "hotel";

  if (level === 0) return "";

  return level === 1 ? "1 house" : `${level} houses`;
};

/** A small colored deed chip; mortgaged deeds are hatched, buildings shown as dots. */
export const deedChip = <M>(h: HtmlBuilder<M>, property: PropertyState): Html => {
  const info = propertyInfo(property.id);
  const buildings = levelText(property.level);

  return h.span(
    [
      h.Class(
        clsx(
          "relative inline-flex h-7 min-w-9 flex-col items-center justify-end overflow-hidden rounded-[3px] border border-line-strong/70 bg-paper px-1 pb-0.5 text-[9px] leading-none font-bold text-ink-2",
          { "opacity-60": property.mortgaged },
        ),
      ),
      h.Title(
        `${info.name}${property.mortgaged ? " (mortgaged)" : ""}${buildings === "" ? "" : `, ${buildings}`}`,
      ),
    ],
    [
      h.span([
        h.Class("absolute inset-x-0 top-0 h-2.5"),
        h.Style({ background: GROUP_COLORS[info.group] }),
      ]),
      property.mortgaged
        ? h.span([
            h.Class(
              "absolute inset-0 bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgba(0,0,0,0.35)_3px_4px)]",
            ),
          ])
        : h.empty,
      property.level === 0
        ? h.span([h.Class("condensed relative uppercase")], [shortName(info.name)])
        : h.span([h.Class("relative flex gap-px")], buildingDots(h, property.level)),
    ],
  );
};

const buildingDots = <M>(h: HtmlBuilder<M>, level: number): ReadonlyArray<Html> =>
  level === 5
    ? [h.span([h.Class("h-2 w-3.5 rounded-[1px] bg-[#d1242a]")])]
    : Array.from({ length: level }, () =>
        h.span([h.Class("h-2 w-1.5 rounded-[1px] bg-[#1b9e52]")]),
      );

/** A 3–5 letter abbreviation of a deed name: "Boardwalk" → "BRDWK", "Park Place" → "PARK". */
export const shortName = (name: string): string => {
  const first = name.replace(/[^A-Za-z ]/g, "").split(" ")[0] ?? name;

  return first.length <= 5 ? first.toUpperCase() : first.slice(0, 4).toUpperCase();
};
