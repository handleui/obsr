import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  assertComposeFileAllowed,
  resolvePathUnderCwd,
} from "./path-safety.js";

describe("resolvePathUnderCwd", () => {
  test("rejects traversal outside cwd", () => {
    expect(() => resolvePathUnderCwd("/project/repo", "..")).toThrow();
    expect(() => resolvePathUnderCwd("/project/repo", "../evil")).toThrow();
  });

  test("allows subdirectory of cwd", () => {
    const cwd = "/project/repo";
    expect(resolvePathUnderCwd(cwd, "sub")).toBe(resolve(cwd, "sub"));
  });

  test("allows cwd itself via dot", () => {
    const cwd = "/project/repo";
    expect(resolvePathUnderCwd(cwd, ".")).toBe(cwd);
  });
});

describe("assertComposeFileAllowed", () => {
  test("blocks compose path outside cwd by default", () => {
    expect(() =>
      assertComposeFileAllowed("/a/b", resolve("/a/other", "c.yaml"), false)
    ).toThrow();
  });

  test("allows when flag set", () => {
    expect(() =>
      assertComposeFileAllowed("/x", resolve("/y", "z.yaml"), true)
    ).not.toThrow();
  });
});
