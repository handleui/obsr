import { describe, expect, it } from "bun:test";
import { validateLogManifest } from "@detent/db";

describe("validateLogManifest", () => {
  it("returns null segments for null input", () => {
    const result = validateLogManifest(null);
    expect(result).toEqual({ segments: null, truncated: false });
  });

  it("returns null segments for undefined input", () => {
    const result = validateLogManifest(undefined);
    expect(result).toEqual({ segments: undefined, truncated: false });
  });

  it("returns empty array for empty array input", () => {
    const result = validateLogManifest([]);
    expect(result).toEqual({ segments: [], truncated: false });
  });

  it("passes through valid segments", () => {
    const segments = [{ start: 1, end: 10, signal: true }];
    const result = validateLogManifest(segments);
    expect(result).toEqual({ segments, truncated: false });
  });

  it("filters segments where start > end", () => {
    const segments = [
      { start: 10, end: 5, signal: true },
      { start: 1, end: 3, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 3, signal: false }]);
  });

  it("filters segments with start < 1", () => {
    const segments = [
      { start: 0, end: 5, signal: true },
      { start: 1, end: 3, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 3, signal: false }]);
  });

  it("filters segments exceeding MAX_SEGMENT_LINE_NUMBER", () => {
    const segments = [
      { start: 1, end: 1_000_001, signal: true },
      { start: 1, end: 100, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 100, signal: false }]);
  });

  it("truncates when exceeding MAX_LOG_MANIFEST_SEGMENTS", () => {
    const segments = Array.from({ length: 1001 }, (_, i) => ({
      start: i + 1,
      end: i + 2,
      signal: i % 2 === 0,
    }));
    const result = validateLogManifest(segments);
    expect(result.truncated).toBe(true);
    expect(result.segments?.length).toBeLessThanOrEqual(1000);
  });

  it("preserves truncatedHint when true", () => {
    const segments = [{ start: 1, end: 10, signal: true }];
    const result = validateLogManifest(segments, true);
    expect(result.truncated).toBe(true);
  });

  it("filters segments with non-integer start values", () => {
    const segments = [
      { start: 1.5, end: 10, signal: true },
      { start: 1, end: 10, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("filters segments with non-integer end values", () => {
    const segments = [
      { start: 1, end: 10.5, signal: true },
      { start: 1, end: 10, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("filters segments with wrong types for start", () => {
    const segments = [
      { start: "1" as any, end: 10, signal: true },
      { start: 1, end: 10, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("filters segments with wrong types for end", () => {
    const segments = [
      { start: 1, end: "10" as any, signal: true },
      { start: 1, end: 10, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("filters segments with wrong types for signal", () => {
    const segments = [
      { start: 1, end: 10, signal: "true" as any },
      { start: 1, end: 10, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("returns null when all segments are invalid", () => {
    const segments = [
      { start: 10, end: 5, signal: true },
      { start: -1, end: 3, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toBeNull();
  });

  it("distinguishes empty input ([]) from all-invalid input (returns null)", () => {
    // Empty array: segments pass through as-is
    const empty = validateLogManifest([]);
    expect(empty.segments).toEqual([]);

    // All-invalid: segments become null (not empty array)
    const allInvalid = validateLogManifest([
      { start: 10, end: 5, signal: true },
    ]);
    expect(allInvalid.segments).toBeNull();
  });

  it("handles segments at boundary values (start=1)", () => {
    const segments = [{ start: 1, end: 5, signal: true }];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 5, signal: true }]);
  });

  it("handles segments at boundary values (end=1_000_000)", () => {
    const segments = [{ start: 1, end: 1_000_000, signal: true }];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([
      { start: 1, end: 1_000_000, signal: true },
    ]);
  });

  it("filters segments with start at upper boundary + 1", () => {
    const segments = [
      { start: 1_000_001, end: 1_000_002, signal: true },
      { start: 1, end: 10, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: false }]);
  });

  it("handles mixed valid and invalid segments", () => {
    const segments = [
      { start: 1, end: 10, signal: true },
      { start: 0, end: 5, signal: false },
      { start: 20, end: 30, signal: true },
      { start: 50, end: 40, signal: false },
      { start: 100, end: 200, signal: true },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([
      { start: 1, end: 10, signal: true },
      { start: 20, end: 30, signal: true },
      { start: 100, end: 200, signal: true },
    ]);
  });

  it("handles exactly MAX_LOG_MANIFEST_SEGMENTS (1000)", () => {
    const segments = Array.from({ length: 1000 }, (_, i) => ({
      start: i + 1,
      end: i + 2,
      signal: i % 2 === 0,
    }));
    const result = validateLogManifest(segments);
    expect(result.truncated).toBe(false);
    expect(result.segments?.length).toBe(1000);
  });

  it("preserves truncatedHint even when no truncation occurs", () => {
    const segments = [{ start: 1, end: 10, signal: true }];
    const result = validateLogManifest(segments, true);
    expect(result.truncated).toBe(true);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: true }]);
  });

  it("handles segments with start equal to end", () => {
    const segments = [{ start: 5, end: 5, signal: true }];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 5, end: 5, signal: true }]);
  });

  it("filters negative start values", () => {
    const segments = [
      { start: -5, end: 10, signal: true },
      { start: 1, end: 10, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: false }]);
  });

  it("filters negative end values", () => {
    const segments = [
      { start: 1, end: -10, signal: true },
      { start: 1, end: 10, signal: false },
    ];
    const result = validateLogManifest(segments);
    expect(result.segments).toEqual([{ start: 1, end: 10, signal: false }]);
  });
});
