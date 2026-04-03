import { requireAuthenticatedUser } from "@/lib/auth-session";
import { handleRouteError, jsonPrivateNoStore } from "@/lib/http";
import { getVercelTargets } from "@/lib/vercel/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = async (request: Request) => {
  try {
    const user = await requireAuthenticatedUser(request);
    return jsonPrivateNoStore(await getVercelTargets(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
};
