import { NextResponse } from "next/server";

// Health check endpoint for uptime monitoring (Better Stack, etc.)
// Returns 200 if the app is running, 503 if critical config is missing

export const GET = () => {
  const checks = {
    workos: Boolean(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID),
    sentry: Boolean(process.env.SENTRY_DSN),
  };

  const status = checks.workos ? "operational" : "degraded";
  const httpStatus = checks.workos ? 200 : 503;

  return NextResponse.json(
    {
      status,
      version: process.env.npm_package_version ?? "unknown",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: httpStatus }
  );
};
