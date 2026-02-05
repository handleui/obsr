import type { ConvexHttpClient } from "convex/browser";

interface PaginationResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

const DEFAULT_MAX_ITEMS = 10_000;

export const fetchAllPages = async <T>(
  convex: ConvexHttpClient,
  name: string,
  args: Record<string, unknown>,
  numItems = 1000,
  maxItems = DEFAULT_MAX_ITEMS
): Promise<T[]> => {
  const items: T[] = [];
  let continueCursor: string | null = null;
  let isDone = false;

  while (!isDone && items.length < maxItems) {
    const result = (await convex.query(name, {
      ...args,
      paginationOpts: { numItems, cursor: continueCursor },
    })) as PaginationResult<T>;

    items.push(...result.page);
    continueCursor = result.continueCursor;
    isDone = result.isDone;
  }

  if (!isDone && items.length >= maxItems) {
    console.warn(
      `[convex-pagination] Hit max items limit (${maxItems}) for ${name}, results may be incomplete`
    );
  }

  return items;
};
