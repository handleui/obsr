import { NextResponse } from "next/server";
import { handleRouteError, parseJsonRequest } from "@/lib/http";
import { MAX_INGEST_REQUEST_BYTES } from "@/lib/issues/constants";
import { IssueIngestInputSchema } from "@/lib/issues/schema";
import { ingestIssue, listIssues, toIssueCreated } from "@/lib/issues/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export const GET = async () => {
  try {
    return NextResponse.json(await listIssues());
  } catch (error) {
    return handleRouteError(error);
  }
};

export const POST = async (request: Request) => {
  try {
    const body = await parseJsonRequest(
      request,
      IssueIngestInputSchema,
      MAX_INGEST_REQUEST_BYTES
    );
    const issue = await ingestIssue(body);
    return NextResponse.json(toIssueCreated(issue), {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
};
