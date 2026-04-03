import { requireAuthenticatedUser } from "@/lib/auth-session";
import {
  handleRouteError,
  jsonPrivateNoStore,
  parseJsonRequest,
} from "@/lib/http";
import { VercelConnectionInputSchema } from "@/lib/vercel/schema";
import { saveVercelConnection } from "@/lib/vercel/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const POST = async (request: Request) => {
  try {
    const user = await requireAuthenticatedUser(request);
    const body = await parseJsonRequest(
      request,
      VercelConnectionInputSchema,
      128_000
    );

    return jsonPrivateNoStore(await saveVercelConnection(user.id, body));
  } catch (error) {
    return handleRouteError(error);
  }
};
