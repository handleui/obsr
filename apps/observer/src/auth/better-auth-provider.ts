import { getBetterAuth } from "../lib/better-auth";
import type { Env } from "../types/env";
import type { AuthPrincipal, AuthProvider } from "./auth-provider";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolveOrganizationId = (session: unknown): string | undefined => {
  if (!isRecord(session)) {
    return undefined;
  }

  const activeOrganizationId = session.activeOrganizationId;
  if (typeof activeOrganizationId === "string") {
    return activeOrganizationId;
  }

  const organizationId = session.organizationId;
  if (typeof organizationId === "string") {
    return organizationId;
  }

  return undefined;
};

const createAuthHeaders = (token: string): Headers =>
  new Headers({ authorization: `Bearer ${token}` });

interface BetterAuthSessionResult {
  user: {
    id: string;
  };
  session?: unknown;
}

const isBetterAuthSessionResult = (
  value: unknown
): value is BetterAuthSessionResult => {
  if (!isRecord(value)) {
    return false;
  }

  const user = value.user;
  return isRecord(user) && typeof user.id === "string";
};

const resolvePrincipal = (sessionResult: unknown): AuthPrincipal => {
  if (!isBetterAuthSessionResult(sessionResult)) {
    throw new Error("Invalid or expired token");
  }

  return {
    userId: sessionResult.user.id,
    organizationId: resolveOrganizationId(sessionResult.session),
  };
};

export const betterAuthProvider: AuthProvider = {
  name: "better-auth",
  verifyBearerToken: async (
    token: string,
    env: Env
  ): Promise<AuthPrincipal> => {
    const auth = getBetterAuth(env);
    const sessionResult = await auth.api.getSession({
      headers: createAuthHeaders(token),
    });

    return resolvePrincipal(sessionResult);
  },
};
