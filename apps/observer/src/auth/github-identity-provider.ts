import type { Env } from "../types/env";
import { betterAuthGitHubIdentityProvider } from "./better-auth-github-identity-provider";

export interface VerifiedGitHubIdentity {
  userId: string;
  username: string;
}

export interface GitHubIdentityProvider {
  name: string;
  getVerifiedGitHubIdentity: (
    authUserId: string,
    env: Env
  ) => Promise<VerifiedGitHubIdentity | null>;
}

export const resolveGitHubIdentityProvider = (
  _env: Env
): GitHubIdentityProvider => {
  return betterAuthGitHubIdentityProvider;
};
