export interface AuthContext {
  userId: string;
  organizationId?: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}
