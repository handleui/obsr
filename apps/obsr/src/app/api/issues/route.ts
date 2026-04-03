import { requireAuthenticatedUser } from "@/lib/auth-session";
import {
  handleRouteError,
  jsonPrivateNoStore,
  parseJsonRequest,
} from "@/lib/http";
import { MAX_INGEST_REQUEST_BYTES } from "@/lib/issues/constants";
import { IssueIngestInputSchema } from "@/lib/issues/schema";
import { ingestIssue, listIssues, toIssueCreated } from "@/lib/issues/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = async (request: Request) => {
  try {
    const user = await requireAuthenticatedUser(request);
    return jsonPrivateNoStore(await listIssues(user.id));
  } catch (error) {
    return handleRouteError(error);
  }
};

export const POST = async (request: Request) => {
  try {
    const user = await requireAuthenticatedUser(request);
    const body = await parseJsonRequest(
      request,
      IssueIngestInputSchema,
      MAX_INGEST_REQUEST_BYTES
    );
    const issue = await ingestIssue(body, user.id);
    return jsonPrivateNoStore(toIssueCreated(issue), {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
};
