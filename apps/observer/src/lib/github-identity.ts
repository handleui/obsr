import type { VerifiedGitHubIdentity } from "../auth/github-identity-provider";
import { resolveGitHubIdentityProvider } from "../auth/github-identity-provider";
import type { Env } from "../types/env";

export const getVerifiedGitHubIdentity = (
  authUserId: string,
  env: Env
): Promise<VerifiedGitHubIdentity | null> => {
  const identityProvider = resolveGitHubIdentityProvider(env);
  return identityProvider.getVerifiedGitHubIdentity(authUserId, env);
};
