/**
 * Geometry of the SVG board, drawn from the engine's board data (40 spaces, US layout):
 * GO at the bottom right, play running clockwise on screen (left along the bottom row).
 * Coordinates are SVG user units of a 1000 × 1000 board; owner tabs sit in a margin outside it.
 */
import { BOARD_SIZE } from "@mb/engine";

export const BOARD = 1000;

export const CORNER = 131;

export const CELL = (BOARD - 2 * CORNER) / 9;

/** Margin around the board for owner tabs. */
export const MARGIN = 26;

/** Depth of the color bar on street spaces. */
export const BAR = 25;

export const VIEW_SIZE = BOARD + 2 * MARGIN;

export const VIEW_BOX = `${-MARGIN} ${-MARGIN} ${VIEW_SIZE} ${VIEW_SIZE}`;

/** Which side of a space faces the center of the board. */
export type InnerSide = "Top" | "Right" | "Bottom" | "Left";

export interface SpaceRect {
  readonly position: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isCorner: boolean;
  /** Side facing the board center (where the color bar goes). */
  readonly inner: InnerSide;
}

const SIDE_LENGTH = 10;

const cornerRect = (position: number, x: number, y: number, inner: InnerSide): SpaceRect => ({
  position,
  x,
  y,
  width: CORNER,
  height: CORNER,
  isCorner: true,
  inner,
});

/** The rectangle of a board position (0 = GO … 39 = Boardwalk). */
export const spaceRect = (position: number): SpaceRect => {
  const side = Math.floor(position / SIDE_LENGTH);
  const offset = position % SIDE_LENGTH;
  const far = BOARD - CORNER;

  if (offset === 0) {
    if (side === 0) return cornerRect(position, far, far, "Top");

    if (side === 1) return cornerRect(position, 0, far, "Top");

    if (side === 2) return cornerRect(position, 0, 0, "Bottom");

    return cornerRect(position, far, 0, "Bottom");
  }

  if (side === 0) {
    return {
      position,
      x: far - offset * CELL,
      y: far,
      width: CELL,
      height: CORNER,
      isCorner: false,
      inner: "Top",
    };
  }

  if (side === 1) {
    return {
      position,
      x: 0,
      y: far - offset * CELL,
      width: CORNER,
      height: CELL,
      isCorner: false,
      inner: "Right",
    };
  }

  if (side === 2) {
    return {
      position,
      x: CORNER + (offset - 1) * CELL,
      y: 0,
      width: CELL,
      height: CORNER,
      isCorner: false,
      inner: "Bottom",
    };
  }

  return {
    position,
    x: far,
    y: CORNER + (offset - 1) * CELL,
    width: CORNER,
    height: CELL,
    isCorner: false,
    inner: "Left",
  };
};

export const SPACE_RECTS: ReadonlyArray<SpaceRect> = Array.from(
  { length: BOARD_SIZE },
  (_, position) => spaceRect(position),
);

/** Center of a space. */
export const spaceCenter = (position: number): readonly [number, number] => {
  const rect = spaceRect(position);

  return [rect.x + rect.width / 2, rect.y + rect.height / 2];
};

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangle of the color bar along the inner side of a space. */
export const barRect = (rect: SpaceRect): Box => {
  if (rect.inner === "Top") return { x: rect.x, y: rect.y, width: rect.width, height: BAR };

  if (rect.inner === "Bottom") {
    return { x: rect.x, y: rect.y + rect.height - BAR, width: rect.width, height: BAR };
  }

  if (rect.inner === "Right") {
    return { x: rect.x + rect.width - BAR, y: rect.y, width: BAR, height: rect.height };
  }

  return { x: rect.x, y: rect.y, width: BAR, height: rect.height };
};

/** Rotation of the text of a space so it reads from outside the board (side columns turn 90°). */
export const textRotation = (rect: SpaceRect): number => {
  if (rect.inner === "Right") return 90;

  if (rect.inner === "Left") return -90;

  return 0;
};

/**
 * The text frame of a non-corner space: width along the board edge, height across it (minus the
 * color bar), centered on `cx, cy`, rotated by `rotation`. Its top faces the color bar on the
 * bottom row and the side columns, and the outer edge on the top row.
 */
export interface TextFrame {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export const textFrame = (rect: SpaceRect, hasBar: boolean): TextFrame => {
  const depth =
    (rect.inner === "Top" || rect.inner === "Bottom" ? rect.height : rect.width) -
    (hasBar ? BAR : 0);

  const along = rect.inner === "Top" || rect.inner === "Bottom" ? rect.width : rect.height;
  const shift = hasBar ? BAR / 2 : 0;
  const [centerX, centerY] = [rect.x + rect.width / 2, rect.y + rect.height / 2];

  if (rect.inner === "Top")
    return { cx: centerX, cy: centerY + shift, width: along, height: depth, rotation: 0 };

  if (rect.inner === "Bottom") {
    return { cx: centerX, cy: centerY - shift, width: along, height: depth, rotation: 0 };
  }

  if (rect.inner === "Right") {
    return { cx: centerX - shift, cy: centerY, width: along, height: depth, rotation: 90 };
  }

  return { cx: centerX + shift, cy: centerY, width: along, height: depth, rotation: -90 };
};

/** Where an owner tab sits: in the margin, just outside the outer edge of the space. */
export const ownerTabCenter = (rect: SpaceRect): readonly [number, number] => {
  const half = MARGIN / 2;

  if (rect.inner === "Top") return [rect.x + rect.width / 2, rect.y + rect.height + half];

  if (rect.inner === "Bottom") return [rect.x + rect.width / 2, rect.y - half];

  if (rect.inner === "Right") return [rect.x - half, rect.y + rect.height / 2];

  return [rect.x + rect.width + half, rect.y + rect.height / 2];
};

// TOKEN MOTION -------------------------------------------------------------------------------

/**
 * Tokens move on a CSS motion path: `inset()` of the board container at the middle of the edge
 * band, clockwise from the top-left corner (Free Parking). Positions plus completed laps give a
 * monotonic distance, so passing GO keeps moving forward.
 */
const PATH_SIDE = BOARD - CORNER;

const PATH_START = 20;

const PERCENT_PER_SIDE = 25;

/** `inset()` of the token motion path, as a percentage of the board container. */
export const TOKEN_PATH_INSET = ((MARGIN + CORNER / 2) / VIEW_SIZE) * 100;

/** Token diameter as a percentage of the board container. */
export const TOKEN_SIZE = (36 / VIEW_SIZE) * 100;

const alongSide = (offset: number): number =>
  offset === 0 ? 0 : CORNER / 2 + CELL / 2 + (offset - 1) * CELL;

/** `offset-distance` (percent of the path) of a token at `position` after `laps` laps. */
export const tokenDistance = (position: number, laps: number): number => {
  const traveled = position + BOARD_SIZE * laps - PATH_START;
  const side = Math.floor(traveled / SIDE_LENGTH);
  const offset = traveled - side * SIDE_LENGTH;

  return side * PERCENT_PER_SIDE + (alongSide(offset) / PATH_SIDE) * PERCENT_PER_SIDE;
};

/**
 * Offsets (in token diameters) that spread the tokens sharing one space; jailed tokens sit in
 * the inner cell of the jail corner, visitors on its outer strip.
 */
export const tokenOffset = (
  position: number,
  slot: number,
  count: number,
  isJailed: boolean,
): readonly [number, number] => {
  const spread = count <= 1 ? 0 : slot - (count - 1) / 2;
  const step = 0.62;

  if (position === 10) {
    return isJailed ? [0.55 + spread * 0.35, -0.55 + spread * 0.35] : [-1.15 + spread * 0.25, 1.15];
  }

  const rect = spaceRect(position);

  if (rect.isCorner) return [spread * step, spread * step * 0.4];

  if (rect.inner === "Top" || rect.inner === "Bottom")
    return [(slot % 2 === 0 ? -1 : 1) * (count > 1 ? 0.42 : 0), spread * step];

  return [spread * step, (slot % 2 === 0 ? -1 : 1) * (count > 1 ? 0.42 : 0)];
};
