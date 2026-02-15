import { type NextRequest, NextResponse } from "next/server";

const DASHBOARD_PREFIXES = new Set(["gh", "gl"]);

const SYSTEM_ROUTES = new Set([
  "auth",
  "login",
  "billing",
  "cli",
  "invitations",
  "verify-email",
  "api",
  "run",
  "monitoring",
  "icon.svg",
  "manifest.webmanifest",
]);

export const proxy = (request: NextRequest) => {
  const { pathname } = request.nextUrl;
  const firstSegment = pathname.split("/")[1];

  // Skip static assets (files with extensions)
  if (
    pathname.includes(".") ||
    !firstSegment ||
    SYSTEM_ROUTES.has(firstSegment)
  ) {
    return NextResponse.next();
  }

  if (DASHBOARD_PREFIXES.has(firstSegment)) {
    return NextResponse.next();
  }

  // Rewrite /:org/:project/:run → /run/:org/:project/:run
  return NextResponse.rewrite(new URL(`/run${pathname}`, request.url));
};

export const config = {
  matcher: "/((?!_next|favicon.ico).*)",
};
