import type { Env } from "../types/env";
import { betterAuthProvider } from "./better-auth-provider";

export interface AuthPrincipal {
  userId: string;
  organizationId?: string;
}

export interface AuthProvider {
  name: string;
  verifyBearerToken: (token: string, env: Env) => Promise<AuthPrincipal>;
}

export const resolveAuthProvider = (_env: Env): AuthProvider => {
  return betterAuthProvider;
};
