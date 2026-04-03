import { requireAuthenticatedUser } from "@/lib/auth-session";
import {
  handleRouteError,
  jsonPrivateNoStore,
  parseJsonRequest,
} from "@/lib/http";
import { VercelSyncRequestSchema } from "@/lib/vercel/schema";
import { syncVercelTargets } from "@/lib/vercel/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = async (request: Request) => {
  try {
    const user = await requireAuthenticatedUser(request);
    const body = await parseJsonRequest(request, VercelSyncRequestSchema);
    return jsonPrivateNoStore(await syncVercelTargets(user.id, body));
  } catch (error) {
    return handleRouteError(error);
  }
};
