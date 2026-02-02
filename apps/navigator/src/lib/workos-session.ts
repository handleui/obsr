import "server-only";

import { cookies } from "next/headers";
import { getWorkOSCookiePassword } from "./auth";
import { COOKIE_NAMES } from "./constants";
import { workos } from "./workos";

export const getWorkOSAccessToken = async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const sealedSession = cookieStore.get(COOKIE_NAMES.workosSession)?.value;

  if (!sealedSession) {
    return null;
  }

  try {
    const cookiePassword = getWorkOSCookiePassword();
    const session = workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword,
    });

    // First check if the current access token is still valid (local JWT validation, no API call).
    // Only refresh if the token has expired to reduce unnecessary WorkOS API calls.
    const authResult = await session.authenticate();
    if (authResult.authenticated && authResult.accessToken) {
      return authResult.accessToken;
    }

    // Token expired or invalid - attempt to refresh via API
    const refreshResult = await session.refresh({ cookiePassword });
    if (!(refreshResult.authenticated && refreshResult.session)) {
      return null;
    }

    return refreshResult.session.accessToken ?? null;
  } catch {
    return null;
  }
};
