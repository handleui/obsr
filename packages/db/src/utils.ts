import { sql } from "drizzle-orm";

import { errorOccurrences } from "./schema/index.js";

export const clampLimit = (
  value: number | null | undefined,
  min: number,
  max: number,
  fallback: number
): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
};

const MAX_COMMON_FILES = 20;

export const commonFilesMergeSql = (filePath: string | undefined) => {
  if (!filePath) {
    return sql`${errorOccurrences.commonFiles}`;
  }
  const jsonb = sql`${JSON.stringify([filePath])}::jsonb`;
  return sql`
    CASE
      WHEN ${errorOccurrences.commonFiles} IS NULL THEN ${jsonb}
      WHEN ${errorOccurrences.commonFiles} @> ${jsonb} THEN ${errorOccurrences.commonFiles}
      WHEN jsonb_array_length(${errorOccurrences.commonFiles}) >= ${MAX_COMMON_FILES} THEN ${errorOccurrences.commonFiles}
      ELSE ${errorOccurrences.commonFiles} || ${jsonb}
    END
  `;
};

export const commonFilesMergeFromExcludedSql = () => sql`
  CASE
    WHEN excluded.common_files IS NULL THEN ${errorOccurrences.commonFiles}
    WHEN ${errorOccurrences.commonFiles} IS NULL THEN excluded.common_files
    WHEN ${errorOccurrences.commonFiles} @> excluded.common_files THEN ${errorOccurrences.commonFiles}
    WHEN jsonb_array_length(${errorOccurrences.commonFiles}) >= ${MAX_COMMON_FILES} THEN ${errorOccurrences.commonFiles}
    ELSE ${errorOccurrences.commonFiles} || excluded.common_files
  END
`;
