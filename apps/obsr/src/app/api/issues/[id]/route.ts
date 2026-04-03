import { requireAuthenticatedUser } from "@/lib/auth-session";
import { handleRouteError, jsonPrivateNoStore } from "@/lib/http";
import { getIssueDetailView } from "@/lib/issues/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface IssueRouteProps {
  params: Promise<{ id: string }>;
}

export const GET = async (_request: Request, { params }: IssueRouteProps) => {
  try {
    const user = await requireAuthenticatedUser(_request);
    const { id } = await params;
    return jsonPrivateNoStore(await getIssueDetailView(id, user.id));
  } catch (error) {
    return handleRouteError(error);
  }
};
