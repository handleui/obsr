import { vercelAdapter } from "@flags-sdk/vercel";
import { dedupe, flag } from "flags/next";

import { getUser } from "@/lib/auth";

interface Entities {
  user?: { id: string };
}

const identify = dedupe(async (): Promise<Entities> => {
  const { isAuthenticated, user } = await getUser();

  if (!(isAuthenticated && user)) {
    return { user: undefined };
  }

  return { user: { id: user.id } };
});

const adapter = process.env.FLAGS
  ? vercelAdapter<boolean, Entities>()
  : undefined;

const createFlag = (key: string) =>
  flag<boolean, Entities>({
    key,
    defaultValue: false,
    identify,
    ...(adapter ? { adapter } : { decide: () => false }),
  });

export const showNewDashboard = createFlag("show-new-dashboard");
export const healingV2 = createFlag("resolving-v2");
export const gitlab = createFlag("gitlab");
