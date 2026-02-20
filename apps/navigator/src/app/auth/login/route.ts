import { NextResponse } from "next/server";
import { gitlab } from "@/flags";
import {
  createSecureCookieOptions,
  generateOAuthState,
  getOAuthRedirectUri,
  getWorkOSClientId,
} from "@/lib/auth";
import { AUTH_DURATIONS, COOKIE_NAMES } from "@/lib/constants";
import { isValidReturnUrl } from "@/lib/return-url";
import { workos } from "@/lib/workos";

type WorkOSProvider = "GitHubOAuth" | "GitLabOAuth";

const PROVIDER_MAP: Record<string, WorkOSProvider> = {
  github: "GitHubOAuth",
  gitlab: "GitLabOAuth",
};

const resolveProvider = async (
  provider: string,
  requestUrl: string
): Promise<WorkOSProvider | NextResponse> => {
  const workosProvider = PROVIDER_MAP[provider.toLowerCase()];
  if (!workosProvider) {
    return NextResponse.redirect(
      new URL("/login?error=invalid_provider", requestUrl)
    );
  }

  if (workosProvider === "GitLabOAuth" && !(await gitlab())) {
    return NextResponse.redirect(
      new URL("/login?error=gitlab_not_available", requestUrl)
    );
  }

  return workosProvider;
};

const buildOAuthResponse = (
  workosProvider: WorkOSProvider,
  state: string,
  returnTo: string | null
) => {
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: workosProvider,
    clientId: getWorkOSClientId(),
    redirectUri: getOAuthRedirectUri(),
    state,
  });

  const response = NextResponse.redirect(authorizationUrl);

  response.cookies.set(
    createSecureCookieOptions({
      name: COOKIE_NAMES.oauthState,
      value: state,
      maxAge: AUTH_DURATIONS.oauthStateMaxAgeSec,
    })
  );

  if (isValidReturnUrl(returnTo)) {
    response.cookies.set(
      createSecureCookieOptions({
        name: COOKIE_NAMES.returnTo,
        value: returnTo,
        maxAge: AUTH_DURATIONS.oauthStateMaxAgeSec,
      })
    );
  }

  return response;
};

export const GET = async (request: Request) => {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  const provider = url.searchParams.get("provider") || "github";

  try {
    const resolved = await resolveProvider(provider, request.url);
    if (resolved instanceof NextResponse) {
      return resolved;
    }

    const state = generateOAuthState();
    return buildOAuthResponse(resolved, state, returnTo);
  } catch (error) {
    console.error("OAuth initiation failed:", error);
    return NextResponse.redirect(
      new URL("/login?error=auth_init_failed", request.url)
    );
  }
};
