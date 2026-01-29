import { type NextRequest, NextResponse } from "next/server";

export const proxy = (request: NextRequest) => {
  const host = request.headers.get("host") || "";

  if (host.startsWith("api.")) {
    return NextResponse.rewrite(new URL("/reference", request.url));
  }

  return NextResponse.next();
};

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
