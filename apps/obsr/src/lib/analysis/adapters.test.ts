import { describe, expect, it } from "vitest";
import { pasteAdapter } from "./adapters";

describe("pasteAdapter", () => {
  it("normalizes windows line endings", () => {
    const result = pasteAdapter.collect({
      inputKind: "paste",
      rawLog: "line one\r\nline two\r\n",
    });

    expect(result).toEqual({
      inputKind: "paste",
      rawLog: "line one\nline two\n",
    });
  });

  it("preserves surrounding whitespace for later validation", () => {
    const result = pasteAdapter.collect({
      inputKind: "paste",
      rawLog: "\n\n   \n",
    });

    expect(result.rawLog).toBe("\n\n   \n");
  });
});
