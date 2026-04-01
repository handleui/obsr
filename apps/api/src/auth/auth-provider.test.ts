import { describe, expect, it } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";
import { resolveAuthProvider } from "./auth-provider";

describe("resolveAuthProvider", () => {
  it("defaults to better-auth", () => {
    const provider = resolveAuthProvider(createMockEnv());

    expect(provider.name).toBe("better-auth");
  });
});
