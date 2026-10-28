/** An in-memory R2 bucket for tests: listing pages of `pageSize` keys, like R2's cursor. */
import { Effect } from "effect";

import type { ArchiveBucket, ArchivePage } from "../archive.ts";

export interface MemoryBucket {
  readonly objects: Map<string, string>;
  readonly bucket: ArchiveBucket<never>;
  /** Calls made to `list` and `delete`, to check the request count. */
  readonly requests: Array<string>;
}

export const memoryBucket = (pageSize = 2): MemoryBucket => {
  const objects = new Map<string, string>();
  const requests: Array<string> = [];

  const list = (options: {
    readonly prefix: string;
    readonly cursor?: string;
  }): Effect.Effect<ArchivePage> =>
    Effect.sync(() => {
      requests.push(`list ${options.prefix}`);

      const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const page = keys.slice(start, start + pageSize).map((key) => ({ key }));

      return start + pageSize < keys.length
        ? { objects: page, truncated: true, cursor: String(start + pageSize) }
        : { objects: page, truncated: false };
    });

  return {
    objects,
    requests,
    bucket: {
      list,
      delete: (keys) =>
        Effect.sync(() => {
          requests.push(`delete ${keys.length}`);

          for (const key of keys) objects.delete(key);
        }),
    },
  };
};
