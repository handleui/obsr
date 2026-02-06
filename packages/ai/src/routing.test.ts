import { describe, expect, it } from "vitest";
import { selectModelForErrors } from "./routing.js";

const err = (category: string | null, stackTrace: string | null = null) => ({
  category,
  stackTrace,
});

describe("selectModelForErrors", () => {
  it("returns Haiku for all lint errors", () => {
    const result = selectModelForErrors([err("lint"), err("lint")]);
    expect(result).toContain("haiku");
  });

  it("returns Haiku for all type-check errors", () => {
    const result = selectModelForErrors([err("type-check")]);
    expect(result).toContain("haiku");
  });

  it("returns Haiku for docs and metadata", () => {
    const result = selectModelForErrors([err("docs"), err("metadata")]);
    expect(result).toContain("haiku");
  });

  it("returns Codex for test errors", () => {
    const result = selectModelForErrors([err("test")]);
    expect(result).toContain("codex");
  });

  it("returns Codex for mixed lint + test", () => {
    const result = selectModelForErrors([err("lint"), err("test")]);
    expect(result).toContain("codex");
  });

  it("returns Codex when any error has stack trace", () => {
    const result = selectModelForErrors([err("lint", "Error at foo.ts:1")]);
    expect(result).toContain("codex");
  });

  it("returns Codex for empty errors", () => {
    const result = selectModelForErrors([]);
    expect(result).toContain("codex");
  });

  it("returns Codex for unknown category", () => {
    const result = selectModelForErrors([err("unknown")]);
    expect(result).toContain("codex");
  });

  it("returns Codex for null category", () => {
    const result = selectModelForErrors([err(null)]);
    expect(result).toContain("codex");
  });

  it("returns Codex for runtime errors", () => {
    const result = selectModelForErrors([err("runtime")]);
    expect(result).toContain("codex");
  });

  it("returns Codex for compile errors", () => {
    const result = selectModelForErrors([err("compile")]);
    expect(result).toContain("codex");
  });
});
