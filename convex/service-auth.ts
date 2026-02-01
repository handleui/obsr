import type { MutationCtx, QueryCtx } from "./_generated/server";

interface ServiceAuthArgs {
  serviceToken?: string | null;
}

export const requireServiceAuth = async (
  ctx: MutationCtx | QueryCtx,
  args: ServiceAuthArgs
): Promise<void> => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity) {
    return;
  }

  const expected = process.env.CONVEX_SERVICE_TOKEN;
  if (!expected || args.serviceToken !== expected) {
    throw new Error("Unauthorized");
  }
};
