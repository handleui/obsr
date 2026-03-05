import { afterEach, describe, expect, it } from "vitest";
import { isDebugEnabled } from "./debug.js";

const originalDebug = process.env.DEBUG;

afterEach(() => {
  if (originalDebug === undefined) {
    process.env.DEBUG = undefined;
    return;
  }
  process.env.DEBUG = originalDebug;
});

describe("isDebugEnabled", () => {
  it("returns false when DEBUG is unset", () => {
    process.env.DEBUG = undefined;
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
