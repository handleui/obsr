import type { ConvexHttpClient } from "convex/browser";

interface PaginationResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

export const fetchAllPages = async <T>(
  convex: ConvexHttpClient,
  name: string,
  args: Record<string, unknown>,
  numItems = 1000
): Promise<T[]> => {
  const items: T[] = [];
  let continueCursor: string | null = null;
  let isDone = false;

  while (!isDone) {
    const result = (await convex.query(name, {
      ...args,
      paginationOpts: { numItems, cursor: continueCursor },
    })) as PaginationResult<T>;

    items.push(...result.page);
    continueCursor = result.continueCursor;
    isDone = result.isDone;
  }

  return items;
};
