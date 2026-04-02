import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { getIssueDetailView } from "@/lib/issues/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface IssueRouteProps {
  params: Promise<{ id: string }>;
}

export const GET = async (_request: Request, { params }: IssueRouteProps) => {
  try {
    const { id } = await params;
    return NextResponse.json(await getIssueDetailView(id));
  } catch (error) {
    return handleRouteError(error);
  }
};
