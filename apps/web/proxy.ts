import { type NextRequest, NextResponse } from "next/server";

export const proxy = (request: NextRequest) => {
  const host = request.headers.get("host") || "";

  // api.detent.sh → serve Scalar API reference
  if (host.startsWith("api.")) {
    const url = new URL("/reference", request.url);
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
};
