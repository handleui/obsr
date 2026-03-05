import { afterEach, describe, expect, it } from "vitest";
import { isDebugEnabled } from "./debug.js";

const originalDebug = process.env.DEBUG;
const unsetDebug = (): void => {
  // biome-ignore lint/performance/noDelete: deleting env key is required to represent an unset variable
  delete process.env.DEBUG;
};

afterEach(() => {
  if (originalDebug === undefined) {
    unsetDebug();
    return;
  }
  process.env.DEBUG = originalDebug;
});

describe("isDebugEnabled", () => {
  it("returns false when DEBUG is unset", () => {
    unsetDebug();
    expect(isDebugEnabled()).toBe(false);
  });

  it("returns true for accepted truthy values", () => {
    process.env.DEBUG = "true";
    expect(isDebugEnabled()).toBe(true);

    process.env.DEBUG = "1";
    expect(isDebugEnabled()).toBe(true);

    process.env.DEBUG = "yes";
    expect(isDebugEnabled()).toBe(true);
  });

  it("returns false for values that should not enable debug", () => {
    process.env.DEBUG = "0";
    expect(isDebugEnabled()).toBe(false);

    process.env.DEBUG = "false";
    expect(isDebugEnabled()).toBe(false);

    process.env.DEBUG = "random";
    expect(isDebugEnabled()).toBe(false);
  });
});
