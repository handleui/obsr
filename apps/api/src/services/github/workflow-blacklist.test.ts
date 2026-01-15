import { describe, expect, it } from "vitest";
import { isBlacklistedWorkflow } from "./workflow-blacklist";

describe("isBlacklistedWorkflow", () => {
  it("matches intended services case-insensitively", () => {
    const names = [
      "Render.com Deploy",
      "Render Deploy",
      "render-deploy",
      "Socket Security Scan",
      "socket.dev scan",
      "Codecov",
    ];

    for (const name of names) {
      expect(isBlacklistedWorkflow(name)).toBe(true);
    }
  });

  it("avoids common workflow false positives", () => {
    const names = [
      "pre-render",
      "render-tests",
      "ssr-render",
      "websocket-tests",
      "socket-server-ci",
    ];

    for (const name of names) {
      expect(isBlacklistedWorkflow(name)).toBe(false);
    }
  });
});
