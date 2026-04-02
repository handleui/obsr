import { getAuth } from "@/lib/auth";

export const runtime = "nodejs";

const handleAuthRequest = (request: Request) => {
  return getAuth().handler(request);
};

export const GET = handleAuthRequest;
export const POST = handleAuthRequest;
