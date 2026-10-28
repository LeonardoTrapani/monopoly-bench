/**
 * Small SVG charts (no chart library): a multi-series line chart and a labelled scatter plot.
 * 2px lines, recessive grid, direct labels plus a legend, native tooltips on hit areas larger
 * than the marks.
 */
import type { Html, HtmlBuilder } from "foldkit/html";

export interface LineSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** Points as `[x, y]`, x ascending. */
  readonly points: ReadonlyArray<readonly [number, number]>;
}

export interface LineChartConfig<M> {
  readonly width: number;
  readonly height: number;
  readonly series: ReadonlyArray<LineSeries>;
  readonly xLabel: string;
  readonly formatX: (value: number) => string;
  readonly formatY: (value: number) => string;
  /** A vertical marker (e.g. the replay cursor). */
  readonly cursorX: number | null;
  /** Vertical hit bands, one per x value, with a tooltip and an optional click Message. */
  readonly bands: ReadonlyArray<Readonly<{ x: number; tooltip: string; onClick: M | null }>>;
  readonly ariaLabel: string;
}

const PADDING = { top: 14, right: 46, bottom: 30, left: 56 } as const;

const TICKS = 4;

const niceStep = (span: number, ticks: number): number => {
  const raw = span / Math.max(1, ticks);
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const residual = raw / magnitude;
  const nice = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1;

  return nice * magnitude;
};

/** Evenly spaced round tick values covering `[min, max]`. */
export const niceTicks = (min: number, max: number, ticks = TICKS): ReadonlyArray<number> => {
  if (max <= min) return [min];

  const tickStep = niceStep(max - min, ticks);
  const start = Math.ceil(min / tickStep) * tickStep;
  const values: Array<number> = [];

  for (let value = start; value <= max + tickStep * 1e-6; value += tickStep) values.push(value);

  return values;
};

const numberAttr = (value: number): string => value.toFixed(2);

/** A multi-series line chart. */
export const lineChart = <M>(h: HtmlBuilder<M>, config: LineChartConfig<M>): Html => {
  const allPoints = config.series.flatMap((series) => series.points);
  const xs = allPoints.map(([x]) => x);
  const ys = allPoints.map(([, y]) => y);
  const minX = Math.min(...xs, 0);
  const maxX = Math.max(...xs, 1);
  const maxY = Math.max(...ys, 1) * 1.05;
  const minY = Math.min(0, ...ys);
  const plotWidth = config.width - PADDING.left - PADDING.right;
  const plotHeight = config.height - PADDING.top - PADDING.bottom;

  const scaleX = (value: number): number =>
    PADDING.left + ((value - minX) / (maxX - minX || 1)) * plotWidth;

  const scaleY = (value: number): number =>
    PADDING.top + (1 - (value - minY) / (maxY - minY || 1)) * plotHeight;

  const yTicks = niceTicks(minY, maxY);
  const xTicks = niceTicks(minX, maxX, 6);
  const bandWidth = config.bands.length > 1 ? plotWidth / config.bands.length : plotWidth;

  const grid = yTicks.map((tick) =>
    h.g(
      [],
      [
        h.line([
          h.X1(numberAttr(PADDING.left)),
          h.X2(numberAttr(config.width - PADDING.right)),
          h.Y1(numberAttr(scaleY(tick))),
          h.Y2(numberAttr(scaleY(tick))),
          h.Stroke("var(--line)"),
          h.StrokeWidth("1"),
        ]),
        h.text(
          [
            h.X(numberAttr(PADDING.left - 8)),
            h.Y(numberAttr(scaleY(tick) + 4)),
            h.Attribute("text-anchor", "end"),
            h.Class("fill-muted num text-[10px]"),
          ],
          [config.formatY(tick)],
        ),
      ],
    ),
  );

  const xAxis = xTicks.map((tick) =>
    h.text(
      [
        h.X(numberAttr(scaleX(tick))),
        h.Y(numberAttr(config.height - PADDING.bottom + 16)),
        h.Attribute("text-anchor", "middle"),
        h.Class("fill-muted num text-[10px]"),
      ],
      [config.formatX(tick)],
    ),
  );

  const lines = config.series.map((series) =>
    h.polyline([
      h.Points(
        series.points
          .map(([x, y]) => `${numberAttr(scaleX(x))},${numberAttr(scaleY(y))}`)
          .join(" "),
      ),
      h.Fill("none"),
      h.Stroke(series.color),
      h.StrokeWidth("2"),
      h.StrokeLinejoin("round"),
      h.StrokeLinecap("round"),
    ]),
  );

  const endLabels = config.series.map((series) => {
    const last = series.points.at(-1);

    if (last === undefined) return h.empty;

    return h.g(
      [],
      [
        h.circle([
          h.Cx(numberAttr(scaleX(last[0]))),
          h.Cy(numberAttr(scaleY(last[1]))),
          h.R("3.5"),
          h.Fill(series.color),
          h.Stroke("var(--paper)"),
          h.StrokeWidth("2"),
        ]),
        h.text(
          [
            h.X(numberAttr(scaleX(last[0]) + 7)),
            h.Y(numberAttr(scaleY(last[1]) + 4)),
            h.Class("fill-ink-2 text-[11px] font-bold"),
          ],
          [series.label],
        ),
      ],
    );
  });

  const cursor =
    config.cursorX === null
      ? h.empty
      : h.line([
          h.X1(numberAttr(scaleX(config.cursorX))),
          h.X2(numberAttr(scaleX(config.cursorX))),
          h.Y1(numberAttr(PADDING.top)),
          h.Y2(numberAttr(config.height - PADDING.bottom)),
          h.Stroke("var(--red)"),
          h.StrokeWidth("1.5"),
          h.Attribute("stroke-dasharray", "4 3"),
        ]);

  const bands = config.bands.map((band) =>
    h.rect(
      [
        h.X(numberAttr(scaleX(band.x) - bandWidth / 2)),
        h.Y(numberAttr(PADDING.top)),
        h.Width(numberAttr(Math.max(bandWidth, 2))),
        h.Height(numberAttr(plotHeight)),
        h.Fill("transparent"),
        h.Class(
          band.onClick === null ? "" : "cursor-pointer hover:fill-[var(--line)] hover:opacity-40",
        ),
        ...(band.onClick === null ? [] : [h.OnClick(band.onClick)]),
      ],
      [h.title([], [band.tooltip])],
    ),
  );

  return h.svg(
    [
      h.ViewBox(`0 0 ${config.width} ${config.height}`),
      h.Class("h-auto w-full select-none"),
      h.Role("img"),
      h.AriaLabel(config.ariaLabel),
    ],
    [
      ...grid,
      ...xAxis,
      h.text(
        [
          h.X(numberAttr(config.width - PADDING.right)),
          h.Y(numberAttr(config.height - 2)),
          h.Attribute("text-anchor", "end"),
          h.Class("fill-muted text-[10px] uppercase tracking-wider"),
        ],
        [config.xLabel],
      ),
      ...lines,
      cursor,
      ...endLabels,
      ...bands,
    ],
  );
};

export interface ScatterPoint<M> {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly tooltip: string;
  readonly isMuted: boolean;
  readonly href: string | null;
  readonly onClick: M | null;
}

export interface ScatterConfig<M> {
  readonly width: number;
  readonly height: number;
  readonly points: ReadonlyArray<ScatterPoint<M>>;
  readonly xLabel: string;
  readonly yLabel: string;
  readonly formatX: (value: number) => string;
  readonly formatY: (value: number) => string;
  /** Use a log10 x axis; points with x ≤ 0 go to a separate lane on the left. */
  readonly isLogX: boolean;
  readonly zeroLaneLabel: string;
  readonly ariaLabel: string;
}

const SCATTER_PADDING = { top: 18, right: 24, bottom: 42, left: 58 } as const;

const ZERO_LANE = 54;

/** A labelled scatter plot (e.g. score vs cost per game). */
export const scatterChart = <M>(h: HtmlBuilder<M>, config: ScatterConfig<M>): Html => {
  const positive = config.points.filter((point) => point.x > 0);
  const hasZeroLane = config.isLogX && positive.length < config.points.length;
  const left = SCATTER_PADDING.left + (hasZeroLane ? ZERO_LANE + 18 : 0);
  const plotWidth = config.width - left - SCATTER_PADDING.right;
  const plotHeight = config.height - SCATTER_PADDING.top - SCATTER_PADDING.bottom;
  const transformX = (value: number): number => (config.isLogX ? Math.log10(value) : value);
  const xValues = positive.map((point) => transformX(point.x));
  const rawMinX = xValues.length === 0 ? 0 : Math.min(...xValues);
  const rawMaxX = xValues.length === 0 ? 1 : Math.max(...xValues);
  const minX = config.isLogX ? Math.floor(rawMinX) : Math.min(0, rawMinX);
  const maxX = config.isLogX ? Math.max(Math.ceil(rawMaxX), minX + 1) : rawMaxX * 1.08 || 1;
  const yValues = config.points.map((point) => point.y);
  const rawMinY = yValues.length === 0 ? 0 : Math.min(...yValues);
  const rawMaxY = yValues.length === 0 ? 1 : Math.max(...yValues);
  const padY = Math.max((rawMaxY - rawMinY) * 0.12, 1);
  const minY = rawMinY - padY;
  const maxY = rawMaxY + padY;

  const scaleY = (value: number): number =>
    SCATTER_PADDING.top + (1 - (value - minY) / (maxY - minY || 1)) * plotHeight;

  const scaleX = (value: number): number => {
    if (config.isLogX && value <= 0) return SCATTER_PADDING.left + ZERO_LANE / 2;

    return left + ((transformX(value) - minX) / (maxX - minX || 1)) * plotWidth;
  };

  const xTicks = config.isLogX
    ? Array.from({ length: maxX - minX + 1 }, (_, index) => 10 ** (minX + index))
    : niceTicks(minX, maxX, 5);

  const yTicks = niceTicks(minY, maxY, 5);

  const grid = [
    ...yTicks.map((tick) =>
      h.g(
        [],
        [
          h.line([
            h.X1(numberAttr(SCATTER_PADDING.left)),
            h.X2(numberAttr(config.width - SCATTER_PADDING.right)),
            h.Y1(numberAttr(scaleY(tick))),
            h.Y2(numberAttr(scaleY(tick))),
            h.Stroke("var(--line)"),
            h.StrokeWidth("1"),
          ]),
          h.text(
            [
              h.X(numberAttr(SCATTER_PADDING.left - 8)),
              h.Y(numberAttr(scaleY(tick) + 4)),
              h.Attribute("text-anchor", "end"),
              h.Class("fill-muted num text-[10px]"),
            ],
            [config.formatY(tick)],
          ),
        ],
      ),
    ),
    ...xTicks.map((tick) =>
      h.g(
        [],
        [
          h.line([
            h.X1(numberAttr(scaleX(tick))),
            h.X2(numberAttr(scaleX(tick))),
            h.Y1(numberAttr(SCATTER_PADDING.top)),
            h.Y2(numberAttr(config.height - SCATTER_PADDING.bottom)),
            h.Stroke("var(--line)"),
            h.StrokeWidth("1"),
            h.Attribute("stroke-dasharray", "2 4"),
          ]),
          h.text(
            [
              h.X(numberAttr(scaleX(tick))),
              h.Y(numberAttr(config.height - SCATTER_PADDING.bottom + 16)),
              h.Attribute("text-anchor", "middle"),
              h.Class("fill-muted num text-[10px]"),
            ],
            [config.formatX(tick)],
          ),
        ],
      ),
    ),
  ];

  const zeroLane = hasZeroLane
    ? h.g(
        [],
        [
          h.rect([
            h.X(numberAttr(SCATTER_PADDING.left + 4)),
            h.Y(numberAttr(SCATTER_PADDING.top)),
            h.Width(numberAttr(ZERO_LANE - 8)),
            h.Height(numberAttr(plotHeight)),
            h.Fill("var(--paper-2)"),
            h.Attribute("rx", "4"),
          ]),
          h.text(
            [
              h.X(numberAttr(SCATTER_PADDING.left + ZERO_LANE / 2)),
              h.Y(numberAttr(config.height - SCATTER_PADDING.bottom + 16)),
              h.Attribute("text-anchor", "middle"),
              h.Class("fill-muted text-[10px]"),
            ],
            [config.zeroLaneLabel],
          ),
        ],
      )
    : h.empty;

  const placedLabels: Array<readonly [number, number, number]> = [];

  const dots = config.points.map((point) => {
    const cx = scaleX(point.x);
    const cy = scaleY(point.y);
    const labelOnLeft = cx > config.width - 150;
    const labelWidth = point.label.length * 6;
    const labelStart = labelOnLeft ? cx - 9 - labelWidth : cx + 9;

    const collides = placedLabels.some(
      ([x, y, width]) => Math.abs(y - cy) < 12 && labelStart < x + width && x < labelStart + labelWidth,
    );

    if (!collides) placedLabels.push([labelStart, cy, labelWidth]);

    const dot = h.g(
      [
        h.Class(point.onClick === null ? "" : "cursor-pointer"),
        ...(point.onClick === null ? [] : [h.OnClick(point.onClick)]),
      ],
      [
        h.title([], [point.tooltip]),
        h.circle([h.Cx(numberAttr(cx)), h.Cy(numberAttr(cy)), h.R("14"), h.Fill("transparent")]),
        h.circle([
          h.Cx(numberAttr(cx)),
          h.Cy(numberAttr(cy)),
          h.R("5.5"),
          h.Fill(point.color),
          h.Stroke("var(--paper)"),
          h.StrokeWidth("2"),
          h.Attribute("opacity", point.isMuted ? "0.55" : "1"),
        ]),
        collides
          ? h.empty
          : h.text(
          [
            h.X(numberAttr(labelOnLeft ? cx - 9 : cx + 9)),
            h.Y(numberAttr(cy + 3.5)),
            h.Attribute("text-anchor", labelOnLeft ? "end" : "start"),
            h.Class(
              point.isMuted ? "fill-muted text-[10.5px]" : "fill-ink-2 text-[10.5px] font-semibold",
            ),
          ],
          [point.label],
        ),
      ],
    );

    return point.href === null ? dot : h.a([h.Attribute("href", point.href), h.AriaLabel(point.tooltip)], [dot]);
  });

  return h.svg(
    [
      h.ViewBox(`0 0 ${config.width} ${config.height}`),
      h.Class("h-auto w-full select-none"),
      h.Role("img"),
      h.AriaLabel(config.ariaLabel),
    ],
    [
      zeroLane,
      ...grid,
      h.text(
        [
          h.X(numberAttr(config.width - SCATTER_PADDING.right)),
          h.Y(numberAttr(config.height - 6)),
          h.Attribute("text-anchor", "end"),
          h.Class("fill-muted text-[10px] uppercase tracking-wider"),
        ],
        [config.xLabel],
      ),
      h.text(
        [
          h.X("12"),
          h.Y(numberAttr(SCATTER_PADDING.top + plotHeight / 2)),
          h.Attribute("text-anchor", "middle"),
          h.Attribute(
            "transform",
            `rotate(-90 12 ${numberAttr(SCATTER_PADDING.top + plotHeight / 2)})`,
          ),
          h.Class("fill-muted text-[10px] uppercase tracking-wider"),
        ],
        [config.yLabel],
      ),
      ...dots,
    ],
  );
};
