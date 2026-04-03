import { RouteError } from "@/lib/http";
import { getAuth } from "./auth";

export const requireAuthenticatedUser = async (request: Request) => {
  const session = await getAuth().api.getSession({
    headers: request.headers,
  });

  if (!session?.user?.id) {
    throw new RouteError(401, "UNAUTHORIZED", "Authentication required.");
  }

  return session.user;
};
