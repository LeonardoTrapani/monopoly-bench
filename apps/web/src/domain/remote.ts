/** `AsyncData` transitions shared by every page (setters for `modifyFields`). */
import { Option, Result } from "effect";
import { AsyncData } from "foldkit";

/** Starts a (re)load: data is kept as `Refreshing`, cold states go to `Loading`. */
export const reload = <A, E>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
  Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data);

/** Settles a load with fresh data. */
export const succeedWith =
  <A>(value: A) =>
  <E>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
    AsyncData.settle(data, Result.succeed(value));

/** Settles a load with an error; previously loaded data is kept as `Stale`. */
export const failWith =
  <E>(error: E) =>
  <A>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
    AsyncData.settle(data, Result.fail(error));
