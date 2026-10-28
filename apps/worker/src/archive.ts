/**
 * Deleting a run's game archives from R2 (`games/<gameId>/…`, SPEC.md §7.3). Game ids start
 * with their run id (`<runId>-<seed>-<rotation>`), so one listing of `games/<runId>-` finds every
 * object of the run in a few requests, however many games it had; only keys of the given games
 * are deleted.
 */
import { gameIdPrefixOf } from "./runs/expand.ts";

/** The part of an R2 bucket this module uses (`R2Bucket` satisfies it). */
export interface ArchiveBucket {
  readonly list: (options: {
    readonly prefix: string;
    readonly cursor?: string;
  }) => Promise<ArchivePage>;
  readonly delete: (keys: Array<string>) => Promise<void>;
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

export const deleteRunArchives = async (
  bucket: ArchiveBucket,
  runId: string,
  gameIds: ReadonlyArray<string>,
): Promise<number> => {
  const games = new Set(gameIds);
  const prefix = `games/${gameIdPrefixOf(runId)}`;
  const keys: Array<string> = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });

    keys.push(
      ...page.objects.flatMap((object) => (games.has(gameOfKey(object.key)) ? [object.key] : [])),
    );
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  for (let index = 0; index < keys.length; index += DELETE_BATCH) {
    await bucket.delete(keys.slice(index, index + DELETE_BATCH));
  }

  return keys.length;
};
