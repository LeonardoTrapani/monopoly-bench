/**
 * Deleting a run's game archives from R2 (`games/<gameId>/…`, SPEC.md §7.3). Game ids start
 * with their run id (`<runId>-<seed>-<rotation>`), so one listing of `games/<runId>-` finds every
 * object of the run in a few requests, however many games it had; only keys of the given games
 * are deleted.
 */
import { Effect } from "effect";

import { gameIdPrefixOf } from "./runs/expand.ts";

/** The part of an R2 bucket this module uses (Alchemy's R2 client satisfies it). */
export interface ArchiveBucket<E> {
  readonly list: (options: {
    readonly prefix: string;
    readonly cursor?: string;
  }) => Effect.Effect<ArchivePage, E>;
  readonly delete: (keys: Array<string>) => Effect.Effect<void, E>;
}

export type ArchivePage =
  | { readonly objects: ReadonlyArray<{ readonly key: string }>; readonly truncated: false }
  | {
      readonly objects: ReadonlyArray<{ readonly key: string }>;
      readonly truncated: true;
      readonly cursor: string;
    };

/** R2 deletes at most 1,000 keys per call. */
const DELETE_BATCH = 1_000;

/** `games/<gameId>/…` → `gameId`. */
const gameOfKey = (key: string): string => key.slice("games/".length).split("/")[0] ?? "";

export const deleteRunArchives = <E>(
  bucket: ArchiveBucket<E>,
  runId: string,
  gameIds: ReadonlyArray<string>,
): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    const games = new Set(gameIds);
    const prefix = `games/${gameIdPrefixOf(runId)}`;
    const keys: Array<string> = [];
    let cursor: string | undefined;

    do {
      const page = yield* bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });

      keys.push(
        ...page.objects.flatMap((object) => (games.has(gameOfKey(object.key)) ? [object.key] : [])),
      );
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);

    for (let index = 0; index < keys.length; index += DELETE_BATCH) {
      yield* bucket.delete(keys.slice(index, index + DELETE_BATCH));
    }

    return keys.length;
  });
