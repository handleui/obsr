import type { ConvexHttpClient } from "convex/browser";

interface PaginationResult<T> {
  page: T[];
  isDone: boolean;
  continueCursor: string;
}

// Safety limit to prevent unbounded memory growth in Cloudflare Workers (128MB limit)
// Most commits have <100 jobs, but pathological cases could have thousands
const DEFAULT_MAX_ITEMS = 10_000;

/**
 * Fetches all pages from a paginated Convex query.
 *
 * Performance note: This function accumulates all items in memory. For Cloudflare
 * Workers with 128MB limit, use maxItems to cap memory usage. Default limit is
 * 10,000 items which should cover most cases while preventing memory exhaustion.
 */
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
