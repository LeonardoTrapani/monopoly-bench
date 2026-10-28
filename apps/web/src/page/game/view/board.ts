/**
 * The board: 40 spaces drawn in SVG from the engine's board data, owner tabs, houses and hotels,
 * mortgaged hatching, and an HTML layer with tokens that glide along the perimeter.
 */
import {
  DECK_NAMES,
  SPACES,
  Space,
  cardAt,
  propertyInfo,
  type GameEvent,
  type GameState,
  type PropertyState,
  type Seat,
} from "@mb/engine";
import clsx from "clsx";
import { Match, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  BOARD,
  CELL,
  CORNER,
  MARGIN,
  SPACE_RECTS,
  TOKEN_PATH_INSET,
  TOKEN_SIZE,
  VIEW_BOX,
  barRect,
  ownerTabCenter,
  textFrame,
  tokenDistance,
  tokenOffset,
  type SpaceRect,
} from "../../../domain/board.ts";
import { money } from "../../../domain/format.ts";
import { GROUP_COLORS, providerOf, SEAT_COLORS, SEAT_INK } from "../../../domain/palette.ts";
import { frameLabel } from "../../../domain/wake.ts";
import { deedCardView } from "../../../view/deed.ts";
import { providerIconUrl } from "../../../view/provider.ts";
import { playerTag, seatPlayer, seatToken, type SeatPlayer } from "../../../view/ui.ts";
import type { Motion } from "../model.ts";

const INK = "var(--board-line)";

const SPACE_FILL = "var(--board)";

const RED = "#d32027";

const NAME_FONT = 14;

const NAME_LINE = 15;

const MAX_LINE_CHARS = 11;

/** Average glyph width of the condensed uppercase board face, in ems. */
const GLYPH_EM = 0.5;

/** Widest a name line may be inside a space. */
const MAX_LINE_WIDTH = CELL - 8;

const fixed = (value: number): string => value.toFixed(1);

/** Greedy word wrap of an uppercase name into lines of at most `MAX_LINE_CHARS`. */
export const wrapName = (name: string): ReadonlyArray<string> => {
  const lines: Array<string> = [];

  for (const word of name.toUpperCase().split(" ")) {
    const last = lines.at(-1);

    if (last !== undefined && last.length + 1 + word.length <= MAX_LINE_CHARS) {
      lines[lines.length - 1] = `${last} ${word}`;
    } else {
      lines.push(word);
    }
  }

  return lines;
};

const propertyStateAt = (state: GameState, position: number): PropertyState | undefined =>
  state.properties.find((property) => propertyInfo(property.id).position === position);

const textLines = <M>(
  h: HtmlBuilder<M>,
  lines: ReadonlyArray<string>,
  top: number,
  className: string,
  size = NAME_FONT,
): ReadonlyArray<Html> =>
  lines.map((line, index) =>
    h.text(
      [
        h.X("0"),
        h.Y(fixed(top + index * NAME_LINE)),
        h.Attribute("text-anchor", "middle"),
        h.Attribute("font-size", `${size}`),
        ...(line.length * size * GLYPH_EM > MAX_LINE_WIDTH
          ? [
              h.Attribute("textLength", `${MAX_LINE_WIDTH}`),
              h.Attribute("lengthAdjust", "spacingAndGlyphs"),
            ]
          : []),
        h.Class(className),
        h.Fill(INK),
      ],
      [line],
    ),
  );

/** A small glyph for non-street spaces, centered at `(0, y)`. */
const glyph = <M>(h: HtmlBuilder<M>, space: Space, y: number): Html =>
  Space.match(space, {
    Property: ({ property }) => {
      const info = propertyInfo(property);

      if (info.kind === "railroad") {
        return h.g(
          [h.Attribute("transform", `translate(0 ${fixed(y)})`)],
          [
            h.rect([
              h.X("-20"),
              h.Y("-10"),
              h.Width("34"),
              h.Height("15"),
              h.Fill(INK),
              h.Attribute("rx", "2"),
            ]),
            h.rect([
              h.X("10"),
              h.Y("-16"),
              h.Width("9"),
              h.Height("21"),
              h.Fill(INK),
              h.Attribute("rx", "1.5"),
            ]),
            h.rect([h.X("-14"), h.Y("-7"), h.Width("8"), h.Height("6"), h.Fill("var(--board)")]),
            h.circle([h.Cx("-12"), h.Cy("9"), h.R("4.5"), h.Fill(INK)]),
            h.circle([h.Cx("2"), h.Cy("9"), h.R("4.5"), h.Fill(INK)]),
            h.circle([h.Cx("14"), h.Cy("9"), h.R("4.5"), h.Fill(INK)]),
          ],
        );
      }

      if (info.position === 12) {
        return h.g(
          [h.Attribute("transform", `translate(0 ${fixed(y)})`)],
          [
            h.circle([
              h.Cx("0"),
              h.Cy("-4"),
              h.R("11"),
              h.Fill("#fbe232"),
              h.Stroke(INK),
              h.StrokeWidth("2"),
            ]),
            h.rect([
              h.X("-5"),
              h.Y("6"),
              h.Width("10"),
              h.Height("8"),
              h.Fill(INK),
              h.Attribute("rx", "1.5"),
            ]),
            h.path([h.D("M-4 -4 L0 2 L4 -4"), h.Stroke(INK), h.StrokeWidth("1.6"), h.Fill("none")]),
          ],
        );
      }

      return h.g(
        [h.Attribute("transform", `translate(0 ${fixed(y)})`)],
        [
          h.path([h.D("M-14 -8 h18 v6 h8 v8 h-6 v-4 h-20 z"), h.Fill(INK)]),
          h.path([h.D("M9 8 q3 5 0 8 q-3 -3 0 -8z"), h.Fill("#2f6fde")]),
        ],
      );
    },
    Chance: () =>
      h.text(
        [
          h.X("0"),
          h.Y(fixed(y + 16)),
          h.Attribute("text-anchor", "middle"),
          h.Attribute("font-size", "48"),
          h.Class("display"),
          h.Fill("#e2571e"),
        ],
        ["?"],
      ),
    CommunityChest: () =>
      h.g(
        [h.Attribute("transform", `translate(0 ${fixed(y)})`)],
        [
          h.rect([
            h.X("-17"),
            h.Y("-10"),
            h.Width("34"),
            h.Height("22"),
            h.Fill("#2f6fde"),
            h.Stroke(INK),
            h.StrokeWidth("1.8"),
            h.Attribute("rx", "3"),
          ]),
          h.path([h.D("M-17 -2 h34"), h.Stroke(INK), h.StrokeWidth("1.8")]),
          h.rect([
            h.X("-4"),
            h.Y("-5"),
            h.Width("8"),
            h.Height("8"),
            h.Fill("#fbe232"),
            h.Stroke(INK),
            h.StrokeWidth("1.2"),
          ]),
        ],
      ),
    Tax: ({ position }) =>
      position === 4
        ? h.path([
            h.D(`M0 ${fixed(y - 14)} L14 ${fixed(y)} L0 ${fixed(y + 14)} L-14 ${fixed(y)} Z`),
            h.Fill("none"),
            h.Stroke(INK),
            h.StrokeWidth("2.5"),
          ])
        : h.g(
            [h.Attribute("transform", `translate(0 ${fixed(y)})`)],
            [
              h.circle([
                h.Cx("0"),
                h.Cy("3"),
                h.R("11"),
                h.Fill("none"),
                h.Stroke(INK),
                h.StrokeWidth("3"),
              ]),
              h.path([
                h.D("M-6 -11 L0 -17 L6 -11 L0 -6 Z"),
                h.Fill("#9fd8f4"),
                h.Stroke(INK),
                h.StrokeWidth("1.5"),
              ]),
            ],
          ),
    Go: () => h.empty,
    Jail: () => h.empty,
    FreeParking: () => h.empty,
    GoToJail: () => h.empty,
  });

const spaceTitle = (space: Space): string =>
  Space.match(space, {
    Property: ({ property }) => {
      const info = propertyInfo(property);

      return `${info.name} · ${money(info.price)}`;
    },
    Tax: ({ name, amount }) => `${name} · pay ${money(amount)}`,
    Go: ({ name }) => name,
    Chance: ({ name }) => name,
    CommunityChest: ({ name }) => name,
    Jail: ({ name }) => name,
    FreeParking: ({ name }) => name,
    GoToJail: ({ name }) => name,
  });

const buildingGlyph = <M>(h: HtmlBuilder<M>, cx: number, cy: number, isHotel: boolean): Html => {
  const width = isHotel ? 22 : 12;
  const height = isHotel ? 13 : 11;

  return h.path([
    h.D(
      `M${fixed(cx - width / 2)} ${fixed(cy + height / 2)} v${fixed(-height * 0.55)} l${fixed(width / 2)} ${fixed(-height * 0.45)} l${fixed(width / 2)} ${fixed(height * 0.45)} v${fixed(height * 0.55)} z`,
    ),
    h.Fill(isHotel ? "#d1242a" : "#1b9e52"),
    h.Stroke("#0d130e"),
    h.StrokeWidth("1.2"),
  ]);
};

/** Houses or a hotel along the color bar of a street. */
const buildingsOn = <M>(h: HtmlBuilder<M>, rect: SpaceRect, level: number): Html => {
  if (level === 0) return h.empty;

  const bar = barRect(rect);
  const isHorizontal = rect.inner === "Top" || rect.inner === "Bottom";
  const centerX = bar.x + bar.width / 2;
  const centerY = bar.y + bar.height / 2;

  if (level === 5) return buildingGlyph(h, centerX, centerY, true);

  const spacing = 16;

  return h.g(
    [],
    Array.from({ length: level }, (_, index) => {
      const offset = (index - (level - 1) / 2) * spacing;

      return isHorizontal
        ? buildingGlyph(h, centerX + offset, centerY, false)
        : buildingGlyph(h, centerX, centerY + offset, false);
    }),
  );
};

/** The owner's tab on a deed: the seat color with the owner's provider logo (or seat letter). */
const ownerTab = <M>(h: HtmlBuilder<M>, rect: SpaceRect, owner: SeatPlayer): Html => {
  const [cx, cy] = ownerTabCenter(rect);
  const isHorizontal = rect.inner === "Top" || rect.inner === "Bottom";
  const width = isHorizontal ? 44 : MARGIN - 6;
  const height = isHorizontal ? MARGIN - 6 : 44;
  const logo = owner.competitorId === "" ? null : providerIconUrl(providerOf(owner.competitorId));

  return h.g(
    [],
    [
      h.rect([
        h.X(fixed(cx - width / 2)),
        h.Y(fixed(cy - height / 2)),
        h.Width(fixed(width)),
        h.Height(fixed(height)),
        h.Attribute("rx", "5"),
        h.Fill(SEAT_COLORS[owner.seat]),
        h.Stroke(INK),
        h.StrokeWidth("1.5"),
      ]),
      logo === null
        ? h.text(
            [
              h.X(fixed(cx)),
              h.Y(fixed(cy + 5)),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("font-size", "14"),
              h.Attribute("font-weight", "800"),
              h.Fill(SEAT_INK[owner.seat]),
            ],
            [owner.seat],
          )
        : h.g(
            [],
            [
              h.circle([h.Cx(fixed(cx)), h.Cy(fixed(cy)), h.R("8.5"), h.Fill("#ffffff")]),
              h.image([
                h.Attribute("href", logo),
                h.X(fixed(cx - 6)),
                h.Y(fixed(cy - 6)),
                h.Width("12"),
                h.Height("12"),
              ]),
            ],
          ),
      h.title([], [`Owned by ${owner.label}`]),
    ],
  );
};

const streetSpace = <M>(
  h: HtmlBuilder<M>,
  rect: SpaceRect,
  space: Space,
  state: GameState,
): Html => {
  const property = Space.match(space, {
    Property: ({ property: id }) => id,
    Go: () => null,
    Tax: () => null,
    Chance: () => null,
    CommunityChest: () => null,
    Jail: () => null,
    FreeParking: () => null,
    GoToJail: () => null,
  });

  const info = property === null ? null : propertyInfo(property);
  const isStreet = info !== null && info.kind === "street";
  const frame = textFrame(rect, isStreet);
  const ownership = info === null ? undefined : propertyStateAt(state, info.position);
  const bar = barRect(rect);
  const nameLines = wrapName(space.name);
  const top = -frame.height / 2 + 15;

  const priceText =
    info === null
      ? Space.matchOrElse(space, { Tax: ({ amount }) => `PAY ${money(amount)}` }, () => "")
      : money(info.price);

  return h.g(
    [h.Class("space")],
    [
      h.title([], [spaceTitle(space)]),
      h.rect([
        h.X(fixed(rect.x)),
        h.Y(fixed(rect.y)),
        h.Width(fixed(rect.width)),
        h.Height(fixed(rect.height)),
        h.Fill(SPACE_FILL),
        h.Stroke(INK),
        h.StrokeWidth("1.5"),
      ]),
      isStreet && info !== null
        ? h.rect([
            h.X(fixed(bar.x)),
            h.Y(fixed(bar.y)),
            h.Width(fixed(bar.width)),
            h.Height(fixed(bar.height)),
            h.Fill(GROUP_COLORS[info.group]),
            h.Stroke(INK),
            h.StrokeWidth("1.5"),
          ])
        : h.empty,
      h.g(
        [
          h.Attribute(
            "transform",
            `translate(${fixed(frame.cx)} ${fixed(frame.cy)}) rotate(${frame.rotation})`,
          ),
        ],
        [
          ...textLines(h, nameLines, top, "board-text"),
          isStreet ? h.empty : glyph(h, space, top + nameLines.length * NAME_LINE + 16),
          h.text(
            [
              h.X("0"),
              h.Y(fixed(frame.height / 2 - 9)),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("font-size", "14"),
              h.Class("board-text"),
              h.Fill(INK),
            ],
            [priceText],
          ),
        ],
      ),
      ownership === undefined || !ownership.mortgaged
        ? h.empty
        : h.g(
            [],
            [
              h.rect([
                h.X(fixed(rect.x)),
                h.Y(fixed(rect.y)),
                h.Width(fixed(rect.width)),
                h.Height(fixed(rect.height)),
                h.Fill("url(#mortgaged)"),
              ]),
              h.title([], [`${info?.name ?? ""} is mortgaged`]),
            ],
          ),
      ownership !== undefined && isStreet ? buildingsOn(h, rect, ownership.level) : h.empty,
      ownership?.owner === undefined || ownership.owner === null
        ? h.empty
        : ownerTab(h, rect, seatPlayer(state.players, ownership.owner)),
    ],
  );
};

const cornerText = <M>(
  h: HtmlBuilder<M>,
  x: number,
  y: number,
  rotation: number,
  children: ReadonlyArray<Html>,
): Html =>
  h.g(
    [h.Attribute("transform", `translate(${fixed(x)} ${fixed(y)}) rotate(${rotation})`)],
    [...children],
  );

const label = <M>(
  h: HtmlBuilder<M>,
  text: string,
  y: number,
  size: number,
  fill: string = INK,
): Html =>
  h.text(
    [
      h.X("0"),
      h.Y(fixed(y)),
      h.Attribute("text-anchor", "middle"),
      h.Attribute("font-size", `${size}`),
      h.Class("board-text"),
      h.Fill(fill),
    ],
    [text],
  );

const corners = <M>(h: HtmlBuilder<M>): ReadonlyArray<Html> => {
  const far = BOARD - CORNER;
  const half = CORNER / 2;
  const jailBox = CORNER * 0.68;

  return [
    h.g(
      [],
      [
        h.title([], ["GO: collect $200 salary as you pass"]),
        h.rect([
          h.X(fixed(far)),
          h.Y(fixed(far)),
          h.Width(`${CORNER}`),
          h.Height(`${CORNER}`),
          h.Fill(SPACE_FILL),
          h.Stroke(INK),
          h.StrokeWidth("1.5"),
        ]),
        cornerText(h, far + half, far + half, -45, [
          label(h, "COLLECT $200", -28, 12),
          label(h, "SALARY AS YOU PASS", -15, 12),
          h.text(
            [
              h.X("0"),
              h.Y("26"),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("font-size", "46"),
              h.Class("wordmark"),
              h.Fill(RED),
            ],
            ["GO"],
          ),
        ]),
        h.path([
          h.D(`M${fixed(far + 22)} ${fixed(far + CORNER - 18)} h70 l-10 -9 m10 9 l-10 9`),
          h.Stroke(RED),
          h.StrokeWidth("5"),
          h.Fill("none"),
          h.StrokeLinecap("round"),
          h.StrokeLinejoin("round"),
          h.Attribute("transform", `rotate(180 ${fixed(far + 57)} ${fixed(far + CORNER - 18)})`),
        ]),
      ],
    ),
    h.g(
      [],
      [
        h.title([], ["Jail / Just visiting"]),
        h.rect([
          h.X("0"),
          h.Y(fixed(far)),
          h.Width(`${CORNER}`),
          h.Height(`${CORNER}`),
          h.Fill(SPACE_FILL),
          h.Stroke(INK),
          h.StrokeWidth("1.5"),
        ]),
        h.rect([
          h.X(fixed(CORNER - jailBox)),
          h.Y(fixed(far)),
          h.Width(fixed(jailBox)),
          h.Height(fixed(jailBox)),
          h.Fill("#f5911e"),
          h.Stroke(INK),
          h.StrokeWidth("1.5"),
        ]),
        ...[0.22, 0.42, 0.62, 0.82].map((ratio) =>
          h.line([
            h.X1(fixed(CORNER - jailBox + jailBox * ratio)),
            h.X2(fixed(CORNER - jailBox + jailBox * ratio)),
            h.Y1(fixed(far + 8)),
            h.Y2(fixed(far + jailBox - 8)),
            h.Stroke(INK),
            h.StrokeWidth("2"),
            h.Attribute("opacity", "0.55"),
          ]),
        ),
        cornerText(h, CORNER - jailBox / 2, far + jailBox / 2, 45, [label(h, "IN JAIL", 5, 15)]),
        cornerText(h, (CORNER - jailBox) / 2, far + CORNER / 2 - 6, 90, [label(h, "JUST", 4, 13)]),
        cornerText(h, CORNER / 2 + 4, far + CORNER - (CORNER - jailBox) / 2 + 1, 0, [
          label(h, "VISITING", 4, 13),
        ]),
      ],
    ),
    h.g(
      [],
      [
        h.title([], ["Free Parking"]),
        h.rect([
          h.X("0"),
          h.Y("0"),
          h.Width(`${CORNER}`),
          h.Height(`${CORNER}`),
          h.Fill(SPACE_FILL),
          h.Stroke(INK),
          h.StrokeWidth("1.5"),
        ]),
        cornerText(h, half, half, 135, [
          label(h, "FREE", -26, 17),
          h.g(
            [h.Attribute("transform", "translate(0 0)")],
            [
              h.path([
                h.D("M-24 6 h48 v-8 l-8 -2 l-6 -9 h-20 l-6 9 l-8 2 z"),
                h.Fill(RED),
                h.Stroke(INK),
                h.StrokeWidth("1.5"),
                h.StrokeLinejoin("round"),
              ]),
              h.circle([h.Cx("-13"), h.Cy("7"), h.R("5"), h.Fill(INK)]),
              h.circle([h.Cx("13"), h.Cy("7"), h.R("5"), h.Fill(INK)]),
            ],
          ),
          label(h, "PARKING", 34, 17),
        ]),
      ],
    ),
    h.g(
      [],
      [
        h.title([], ["Go To Jail"]),
        h.rect([
          h.X(fixed(far)),
          h.Y("0"),
          h.Width(`${CORNER}`),
          h.Height(`${CORNER}`),
          h.Fill(SPACE_FILL),
          h.Stroke(INK),
          h.StrokeWidth("1.5"),
        ]),
        cornerText(h, far + half, half, -135, [
          label(h, "GO TO", -24, 17),
          h.path([
            h.D("M-16 -4 h32 v20 h-32 z M-8 -4 v20 M0 -4 v20 M8 -4 v20"),
            h.Fill("none"),
            h.Stroke(INK),
            h.StrokeWidth("2.2"),
          ]),
          label(h, "JAIL", 37, 17),
        ]),
      ],
    ),
  ];
};

const centerDecor = <M>(h: HtmlBuilder<M>): Html => {
  const deck = (x: number, y: number, text: string, color: string): Html =>
    h.g(
      [h.Attribute("transform", `translate(${x} ${y}) rotate(-45)`)],
      [
        h.rect([
          h.X("-70"),
          h.Y("-42"),
          h.Width("140"),
          h.Height("84"),
          h.Attribute("rx", "8"),
          h.Fill("none"),
          h.Stroke(color),
          h.StrokeWidth("2.5"),
          h.Attribute("stroke-dasharray", "7 5"),
        ]),
        h.text(
          [
            h.X("0"),
            h.Y("5"),
            h.Attribute("text-anchor", "middle"),
            h.Attribute("font-size", "15"),
            h.Class("board-text"),
            h.Fill(color),
          ],
          [text],
        ),
      ],
    );

  return h.g(
    [],
    [
      h.rect([
        h.X(fixed(CORNER)),
        h.Y(fixed(CORNER)),
        h.Width(fixed(BOARD - 2 * CORNER)),
        h.Height(fixed(BOARD - 2 * CORNER)),
        h.Fill("var(--board)"),
      ]),
      deck(300, 300, "COMMUNITY CHEST", "#2f6fde"),
      deck(700, 700, "CHANCE", "#e2571e"),
      h.g(
        [
          h.Attribute("transform", "translate(500 500) rotate(-45)"),
          h.Attribute("opacity", "0.22"),
        ],
        [
          h.rect([
            h.X("-250"),
            h.Y("-50"),
            h.Width("500"),
            h.Height("100"),
            h.Fill(RED),
            h.Stroke(INK),
            h.StrokeWidth("3"),
          ]),
          h.text(
            [
              h.X("0"),
              h.Y("22"),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("font-size", "62"),
              h.Class("wordmark"),
              h.Fill("#ffffff"),
            ],
            ["MONOPOLY"],
          ),
        ],
      ),
    ],
  );
};

const patterns = <M>(h: HtmlBuilder<M>): Html =>
  h.defs(
    [],
    [
      h.pattern(
        [
          h.Id("mortgaged"),
          h.Attribute("patternUnits", "userSpaceOnUse"),
          h.Width("9"),
          h.Height("9"),
          h.Attribute("patternTransform", "rotate(45)"),
        ],
        [
          h.rect([
            h.X("0"),
            h.Y("0"),
            h.Width("9"),
            h.Height("9"),
            h.Fill("rgba(255,255,255,0.35)"),
          ]),
          h.line([
            h.X1("0"),
            h.Y1("0"),
            h.X2("0"),
            h.Y2("9"),
            h.Stroke("rgba(20,24,20,0.55)"),
            h.StrokeWidth("3"),
          ]),
        ],
      ),
    ],
  );

export interface TokenInput {
  readonly seat: Seat;
  readonly competitorId: string;
  readonly position: number;
  readonly laps: number;
  readonly isJailed: boolean;
  readonly isActive: boolean;
  readonly isBankrupt: boolean;
}

/** The token layer: one HTML token per seat, moved with a CSS motion path. */
const tokenLayer = <M>(
  h: HtmlBuilder<M>,
  tokens: ReadonlyArray<TokenInput>,
  motion: Motion,
): Html => {
  const alive = tokens.filter((token) => !token.isBankrupt);

  return h.div(
    [h.Class("pointer-events-none absolute inset-0"), h.AriaHidden(true)],
    alive.map((token) => {
      const sharing = alive.filter(
        (other) => other.position === token.position && other.isJailed === token.isJailed,
      );

      const slot = sharing.findIndex((other) => other.seat === token.seat);
      const [dx, dy] = tokenOffset(token.position, slot, sharing.length, token.isJailed);

      const logo =
        token.competitorId === "" ? null : providerIconUrl(providerOf(token.competitorId));

      return h.keyed("div")(
        token.seat,
        [
          h.Class(
            clsx("token absolute top-0 left-0", { "!transition-none": motion === "Instant" }),
          ),
          h.Style({
            width: `${TOKEN_SIZE}%`,
            height: `${TOKEN_SIZE}%`,
            offsetPath: `inset(${TOKEN_PATH_INSET}%)`,
            offsetDistance: `${tokenDistance(token.position, token.laps)}%`,
            offsetRotate: "0deg",
            zIndex: token.isActive ? "3" : "2",
          }),
        ],
        [
          h.div(
            [
              h.Class(
                clsx(
                  "flex h-full w-full items-center justify-center rounded-full text-[clamp(8px,1.3vw,13px)] font-black shadow-[0_2px_3px_rgba(0,0,0,0.45)] transition-transform duration-300",
                  logo === null
                    ? "border-2 border-white"
                    : "border-[clamp(2px,0.45vw,4px)] bg-white",
                  { "ring-4 ring-white/80 ring-offset-1 ring-offset-black/40": token.isActive },
                ),
              ),
              h.Style({
                ...(logo === null
                  ? { background: SEAT_COLORS[token.seat], color: SEAT_INK[token.seat] }
                  : { borderColor: SEAT_COLORS[token.seat] }),
                transform: `translate(${(dx * 100).toFixed(0)}%, ${(dy * 100).toFixed(0)}%)`,
              }),
            ],
            [
              logo === null
                ? token.seat
                : h.img([h.Src(logo), h.Alt(""), h.Class("h-[62%] w-[62%] object-contain")]),
            ],
          ),
        ],
      );
    }),
  );
};

/** Pip positions of die faces 1–6. */
const PIPS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[50, 50]],
  [
    [28, 28],
    [72, 72],
  ],
  [
    [28, 28],
    [50, 50],
    [72, 72],
  ],
  [
    [28, 28],
    [72, 28],
    [28, 72],
    [72, 72],
  ],
  [
    [28, 28],
    [72, 28],
    [50, 50],
    [28, 72],
    [72, 72],
  ],
  [
    [28, 26],
    [72, 26],
    [28, 50],
    [72, 50],
    [28, 74],
    [72, 74],
  ],
];

/** Two dice faces with pips. */
export const diceView = <M>(h: HtmlBuilder<M>, dice: readonly [number, number] | null): Html => {
  if (dice === null) return h.empty;

  const face = (value: number, key: string): Html =>
    h.keyed("svg")(
      key,
      [
        h.ViewBox("0 0 100 100"),
        h.Class("h-9 w-9 drop-shadow-[2px_2px_0_rgba(0,0,0,0.25)] sm:h-11 sm:w-11"),
        h.Role("img"),
        h.AriaLabel(`${value}`),
      ],
      [
        h.rect([
          h.X("3"),
          h.Y("3"),
          h.Width("94"),
          h.Height("94"),
          h.Attribute("rx", "18"),
          h.Fill("#fffdf8"),
          h.Stroke("#161b17"),
          h.StrokeWidth("5"),
        ]),
        ...(PIPS[value - 1] ?? []).map(([cx, cy]) =>
          h.circle([h.Cx(`${cx}`), h.Cy(`${cy}`), h.R("9"), h.Fill(value === 1 ? RED : "#161b17")]),
        ),
      ],
    );

  return h.div([h.Class("flex gap-2")], [face(dice[0], "die-1"), face(dice[1], "die-2")]);
};

/** What the center of the board shows: the decision or card of the moment. */
const centerCard = <M>(
  h: HtmlBuilder<M>,
  state: GameState,
  lastEvent: GameEvent | undefined,
): Html => {
  const frame = state.control.stack.at(-1);

  if (state.status === "finished") {
    const winner = state.players.find((player) => player.seat === state.winner);

    return h.div(
      [h.Class("text-center")],
      [
        h.p(
          [h.Class("deed-kicker text-red")],
          [state.endReason === "turnCap" ? "Turn cap reached" : "Game over"],
        ),
        h.p(
          [h.Class("display mt-1 text-lg leading-tight text-ink sm:text-2xl")],
          [
            winner === undefined
              ? "No winner"
              : h.span(
                  [h.Class("inline-flex items-center gap-2")],
                  [seatToken(h, winner, "md"), `${winner.label} wins`],
                ),
          ],
        ),
      ],
    );
  }

  if (lastEvent !== undefined && Predicate.isTagged(lastEvent, "CardDrawn")) {
    const card = cardAt(lastEvent.deck, lastEvent.card);

    return h.div(
      [h.Class("deed w-full max-w-[15rem] overflow-hidden")],
      [
        h.div(
          [
            h.Class(
              clsx(
                "px-3 py-1.5 text-white",
                lastEvent.deck === "chance" ? "bg-[#e2571e]" : "bg-[#2f6fde]",
              ),
            ),
          ],
          [
            h.p(
              [h.Class("deed-kicker flex items-center gap-1.5")],
              [
                seatToken(h, seatPlayer(state.players, lastEvent.seat), "xs"),
                `${seatPlayer(state.players, lastEvent.seat).label} drew ${DECK_NAMES[lastEvent.deck]}`,
              ],
            ),
          ],
        ),
        h.p([h.Class("px-3 py-2.5 text-xs leading-snug text-ink sm:text-sm")], [card.text]),
      ],
    );
  }

  if (frame === undefined) return h.empty;

  return Match.value(frame).pipe(
    Match.withReturnType<Html>(),
    Match.tag("BuyChoice", (choice) =>
      h.div(
        [h.Class("flex flex-col items-center gap-2")],
        [
          h.p(
            [h.Class("flex flex-wrap items-center justify-center gap-1 text-xs text-ink-2")],
            [playerTag(h, seatPlayer(state.players, choice.seat)), "may buy or send to auction"],
          ),
          deedCardView(h, choice.property),
        ],
      ),
    ),
    Match.tag("Auction", (auction) =>
      h.div(
        [h.Class("flex flex-col items-center gap-2")],
        [
          h.p([h.Class("deed-kicker text-red")], [`Auction · round ${auction.round}`]),
          deedCardView(
            h,
            auction.property,
            h.div(
              [
                h.Class(
                  "mt-1 rounded bg-paper-2 px-2 py-1 text-center text-xs font-semibold text-ink",
                ),
              ],
              auction.high === null
                ? ["No bids yet"]
                : [
                    h.span(
                      [h.Class("inline-flex flex-wrap items-center justify-center gap-1")],
                      [
                        `High bid ${money(auction.high.amount)} by`,
                        playerTag(h, seatPlayer(state.players, auction.high.seat)),
                      ],
                    ),
                  ],
            ),
          ),
        ],
      ),
    ),
    Match.tag("RaiseFunds", (debt) =>
      h.div(
        [h.Class("max-w-[16rem] text-center")],
        [
          h.p([h.Class("deed-kicker text-red")], ["Raising funds"]),
          h.p(
            [
              h.Class(
                "mt-1 flex flex-wrap items-center justify-center gap-1 text-sm text-ink sm:text-base",
              ),
            ],
            [
              playerTag(h, seatPlayer(state.players, debt.debtor)),
              `owes ${money(debt.amount)} to`,
              debt.creditor === "bank"
                ? "the bank"
                : playerTag(h, seatPlayer(state.players, debt.creditor)),
            ],
          ),
        ],
      ),
    ),
    Match.orElse((other) =>
      h.div(
        [h.Class("text-center")],
        [
          h.p([h.Class("deed-kicker text-ink-2")], [frameLabel(other._tag)]),
          h.p(
            [
              h.Class(
                "mt-1 flex flex-wrap items-center justify-center gap-1 text-sm text-ink sm:text-base",
              ),
            ],
            [
              `Turn ${state.control.turn} ·`,
              playerTag(h, seatPlayer(state.players, state.control.activeSeat)),
              "to play",
            ],
          ),
        ],
      ),
    ),
  );
};

export interface BoardInput {
  readonly state: GameState;
  readonly tokens: ReadonlyArray<TokenInput>;
  readonly motion: Motion;
  readonly lastEvent: GameEvent | undefined;
}

export const boardView = <M>(h: HtmlBuilder<M>, input: BoardInput): Html =>
  h.div(
    [h.Class("relative aspect-square w-full select-none")],
    [
      h.svg(
        [
          h.ViewBox(VIEW_BOX),
          h.Class("absolute inset-0 h-full w-full"),
          h.Role("img"),
          h.AriaLabel("Monopoly board"),
        ],
        [
          patterns(h),
          h.rect([
            h.X("-6"),
            h.Y("-6"),
            h.Width(`${BOARD + 12}`),
            h.Height(`${BOARD + 12}`),
            h.Attribute("rx", "10"),
            h.Fill("var(--board-2)"),
            h.Stroke(INK),
            h.StrokeWidth("3"),
          ]),
          centerDecor(h),
          ...SPACES.flatMap((space, position) => {
            const rect = SPACE_RECTS[position];

            return rect === undefined || rect.isCorner
              ? []
              : [streetSpace(h, rect, space, input.state)];
          }),
          ...corners(h),
          h.rect([
            h.X(fixed(CORNER)),
            h.Y(fixed(CORNER)),
            h.Width(fixed(BOARD - 2 * CORNER)),
            h.Height(fixed(BOARD - 2 * CORNER)),
            h.Fill("none"),
            h.Stroke(INK),
            h.StrokeWidth("2.5"),
          ]),
          h.rect([
            h.X("0"),
            h.Y("0"),
            h.Width(`${BOARD}`),
            h.Height(`${BOARD}`),
            h.Fill("none"),
            h.Stroke(INK),
            h.StrokeWidth("3"),
          ]),
        ],
      ),
      h.div(
        [
          h.Class(
            "pointer-events-none absolute inset-[22%] flex flex-col items-center justify-center gap-3",
          ),
        ],
        [centerCard(h, input.state, input.lastEvent), diceView(h, input.state.lastDice)],
      ),
      tokenLayer(h, input.tokens, input.motion),
    ],
  );
