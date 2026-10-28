/** URL routes of the web app (SPEC §9). Routers print URLs; never build paths by hand. */
import { Schema, pipe } from "effect";
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

/** Competitor ids contain `/` and `:` (`anthropic/claude-x:high`), so they take the rest of the path. */
export const competitorRouter = pipe(
  literal("models"),
  slash(restString("competitorId")),
  Route.mapTo(AppRoute.Competitor),
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
