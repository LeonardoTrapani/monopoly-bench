/** URL routes of the web app (SPEC §9). Routers print URLs; never build paths by hand. */
import { Option, Schema, pipe } from "effect";
import { Route } from "foldkit";
import { defineRouteUnion, literal, restString, slash, string } from "foldkit/route";

export const AppRoute = defineRouteUnion({
  Home: {},
  Games: {},
  Game: { gameId: Schema.String },
  Competitor: { competitorId: Schema.String },
  Runs: {},
  NewRun: {},
  Run: { runId: Schema.String },
  About: {},
  NotFound: { path: Schema.String },
});

export type AppRoute = typeof AppRoute.Type;

export const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home));

export const gamesRouter = pipe(literal("games"), Route.mapTo(AppRoute.Games));

export const gameRouter = pipe(
  literal("games"),
  slash(string("gameId")),
  Route.mapTo(AppRoute.Game),
);

const tryDecodeUriComponent = Option.liftThrowable(decodeURIComponent);

/** Percent-decodes a URL piece (`bot%3Arandom` → `bot:random`); malformed escapes stay as typed. */
export const decodeUriPart = (text: string): string =>
  Option.getOrElse(tryDecodeUriComponent(text), () => text);

/**
 * Competitor ids contain `/` and `:` (`anthropic/claude-x:high`), so they take the rest of the
 * path. Links print the raw id; a pasted or shared URL may arrive percent-encoded
 * (`/models/bot%3Arandom`, `/models/anthropic%2Fclaude-x`), so parsing decodes it and the route
 * always holds the raw id (the API client encodes it once).
 */
export const competitorRouter = pipe(
  literal("models"),
  slash(restString("competitorId")),
  Route.mapTo({
    make: ({ competitorId }: Readonly<{ competitorId: string }>) =>
      AppRoute.Competitor({ competitorId: decodeUriPart(competitorId) }),
  }),
);

export const runsRouter = pipe(literal("runs"), Route.mapTo(AppRoute.Runs));

export const newRunRouter = pipe(
  literal("runs"),
  slash(literal("new")),
  Route.mapTo(AppRoute.NewRun),
);

export const runRouter = pipe(literal("runs"), slash(string("runId")), Route.mapTo(AppRoute.Run));

export const aboutRouter = pipe(literal("about"), Route.mapTo(AppRoute.About));

const routeParser = Route.oneOf(
  newRunRouter,
  runRouter,
  runsRouter,
  gameRouter,
  gamesRouter,
  competitorRouter,
  aboutRouter,
  homeRouter,
);

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound);

/** Link to a competitor's profile (bots and LLMs alike). */
export const competitorHref = (competitorId: string): string => competitorRouter({ competitorId });

export const gameHref = (gameId: string): string => gameRouter({ gameId });

export const runHref = (runId: string): string => runRouter({ runId });
