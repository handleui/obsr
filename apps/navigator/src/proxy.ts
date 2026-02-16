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

const TRAVERSAL_PATTERNS = ["..", ".", "\0", "%2e", "%2E", "%2f", "%2F", "%00"];

const hasPathTraversal = (segments: string[]): boolean =>
  segments.some((s) => {
    if (!s || typeof s !== "string") {
      return true;
    }
    try {
      const decoded = decodeURIComponent(s);
      return TRAVERSAL_PATTERNS.some(
        (p) => s === p || s.includes(p) || decoded.includes(p)
      );
    } catch {
      return true;
    }
  });

export const proxy = (request: NextRequest) => {
  const { pathname } = request.nextUrl;
  const segments = pathname.split("/").filter(Boolean);
  const firstSegment = segments[0];

  if (hasPathTraversal(segments)) {
    return NextResponse.next();
  }

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

  return NextResponse.rewrite(new URL(`/run${pathname}`, request.url));
};

export const config = {
  matcher: "/((?!_next|favicon.ico).*)",
};
