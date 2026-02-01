import { v } from "convex/values";

export const nullableString = v.union(v.string(), v.null());
export const nullableNumber = v.union(v.number(), v.null());
export const nullableBoolean = v.union(v.boolean(), v.null());
export const nullableStringArray = v.union(v.array(v.string()), v.null());

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

export const buildPatch = (
  fields: Record<string, unknown>
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  return patch;
};

export const trimString = (
  value: string | undefined,
  maxLength: number
): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};
