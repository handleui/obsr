import { NextResponse } from "next/server";
import { MAX_ANALYSIS_REQUEST_BYTES } from "@/lib/analysis/constants";
import { createAnalysis, listAnalyses } from "@/lib/analysis/service";
import { AnalysisCreateInputSchema } from "@/lib/contracts";
import { handleRouteError, parseJsonRequest } from "@/lib/http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = async () => {
  try {
    return NextResponse.json(await listAnalyses());
  } catch (error) {
    return handleRouteError(error);
  }
};

export const POST = async (request: Request) => {
  try {
    const body = await parseJsonRequest(
      request,
      AnalysisCreateInputSchema,
      MAX_ANALYSIS_REQUEST_BYTES
    );
    return NextResponse.json(await createAnalysis(body), {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
};
