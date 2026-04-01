import { NextResponse } from "next/server";
import { getAnalysisDetail } from "@/lib/analysis/service";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

interface AnalysisRouteProps {
  params: Promise<{ id: string }>;
}

export const GET = async (
  _request: Request,
  { params }: AnalysisRouteProps
) => {
  try {
    const { id } = await params;
    return NextResponse.json(await getAnalysisDetail(id));
  } catch (error) {
    return handleRouteError(error);
  }
};
