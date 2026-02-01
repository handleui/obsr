import "convex/browser";

declare module "convex/browser" {
  interface ConvexHttpClient {
    query(name: string, args?: Record<string, unknown>): Promise<unknown>;
    mutation(name: string, args?: Record<string, unknown>): Promise<unknown>;
  }
}
