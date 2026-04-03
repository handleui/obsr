import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

export const runtime = "nodejs";

export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler((request) => {
  return getAuth().handler(request);
});
