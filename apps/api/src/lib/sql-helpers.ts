/**
 * SQL helper utilities for batch operations
 */

import { type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Build SQL CASE expression for batch updates.
 * Enables efficient single-query updates with different values per row.
 *
 * @example
 * ```ts
 * const items = [{ id: "1", value: "a" }, { id: "2", value: "b" }];
 * db.update(table).set({
 *   column: buildCaseExpression(items, table.id)
 * }).where(inArray(table.id, items.map(i => i.id)));
 * // Generates: SET column = (CASE WHEN id = '1' THEN 'a' WHEN id = '2' THEN 'b' END)
 * ```
 */
export const buildCaseExpression = <T>(
  items: Array<{ id: string; value: T }>,
  column: PgColumn
): ReturnType<typeof sql.join> => {
  const chunks: SQL[] = [sql`(case`];
  for (const { id, value } of items) {
    chunks.push(sql` when ${column} = ${id} then ${value}`);
  }
  chunks.push(sql` end)`);
  return sql.join(chunks, sql.raw(""));
};
