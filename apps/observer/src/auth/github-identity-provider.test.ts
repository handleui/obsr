import { describe, expect, it } from "vitest";
import { createMockEnv } from "../test-helpers/mock-env";
import { resolveGitHubIdentityProvider } from "./github-identity-provider";

describe("resolveGitHubIdentityProvider", () => {
  it("defaults to better-auth", () => {
    const provider = resolveGitHubIdentityProvider(createMockEnv());

    expect(provider.name).toBe("better-auth");
  });
});
