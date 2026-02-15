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

const createFlag = (key: string) =>
  flag<boolean, Entities>({
    key,
    defaultValue: false,
    identify,
    adapter: vercelAdapter(),
  });

export const showNewDashboard = createFlag("show-new-dashboard");
export const healingV2 = createFlag("healing-v2");
