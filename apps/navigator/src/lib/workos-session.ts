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

    const refreshResult = await session.refresh({ cookiePassword });
    if (!(refreshResult.authenticated && refreshResult.session)) {
      return null;
    }

    return refreshResult.session.accessToken ?? null;
  } catch {
    return null;
  }
};
