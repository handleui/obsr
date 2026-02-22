"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getWorkOSCookiePassword } from "@/lib/auth";
import { API_BASE_URL, COOKIE_NAMES } from "@/lib/constants";
import { isValidTokenFormat } from "@/lib/validation";
import { getWorkOS } from "@/lib/workos";

export interface AcceptState {
  success: boolean;
  error: string | null;
  organizationName?: string;
  organizationSlug?: string;
}

interface AcceptResponse {
  success: boolean;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  role: string;
}

interface AcceptError {
  error: string;
  code?: string;
  message?: string;
}

/** Map HTTP status codes to user-friendly error messages */
const getErrorForStatus = (
  status: number,
  errorData: AcceptError
): AcceptState | null => {
  if (status === 403 && errorData.code === "GITHUB_NOT_LINKED") {
    return {
      success: false,
      error: "Please link your GitHub account before accepting the invitation.",
    };
  }

  if (status === 409) {
    return {
      success: false,
      error: "You are already a member of this organization.",
    };
  }

  if (status === 410) {
    return {
      success: false,
      error: errorData.error || "This invitation is no longer available.",
    };
  }

  if (status === 400) {
    return {
      success: false,
      error: errorData.error || "This invitation is no longer valid.",
    };
  }

  if (status === 404) {
    return {
      success: false,
      error: "Invitation not found.",
    };
  }

  if (status >= 500) {
    return {
      success: false,
      error:
        "We're experiencing technical difficulties. Please try again later.",
    };
  }

  return null;
};

/**
 * Get access token from sealed session
 * Returns null if session is invalid or expired
 */
const getAccessToken = async (): Promise<string | null> => {
  const cookieStore = await cookies();
  const sealedSession = cookieStore.get(COOKIE_NAMES.workosSession)?.value;

  if (!sealedSession) {
    return null;
  }

  try {
    const cookiePassword = getWorkOSCookiePassword();
    const session = getWorkOS().userManagement.loadSealedSession({
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

export const acceptInvitation = async (
  _prevState: AcceptState,
  formData: FormData
): Promise<AcceptState> => {
  const token = formData.get("token");

  if (typeof token !== "string" || !token) {
    return { success: false, error: "Invalid invitation token" };
  }

  // Validate token format to prevent injection attacks
  if (!isValidTokenFormat(token)) {
    return { success: false, error: "Invalid invitation token format" };
  }

  // Get access token for authenticated API call
  const accessToken = await getAccessToken();

  if (!accessToken) {
    // Session expired - need to re-authenticate
    const returnTo = `/invitations/${token}`;
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  // Using AbortController for timeout to prevent hanging requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${API_BASE_URL}/v1/invitations/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorData: AcceptError = { error: "Unknown error" };
      try {
        errorData = (await response.json()) as AcceptError;
      } catch {
        // Fall through with default error
      }

      // Authentication required - redirect to login
      if (response.status === 401) {
        const returnTo = `/invitations/${token}`;
        redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      }

      // Check for known error statuses
      const knownError = getErrorForStatus(response.status, errorData);
      if (knownError) {
        return knownError;
      }

      return {
        success: false,
        error: errorData.error || "Failed to accept invitation.",
      };
    }

    const data = (await response.json()) as AcceptResponse;

    return {
      success: true,
      error: null,
      organizationName: data.organization_name,
      organizationSlug: data.organization_slug,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    // Handle timeout/abort errors
    if (err instanceof Error && err.name === "AbortError") {
      return {
        success: false,
        error: "Request timed out. Please try again.",
      };
    }

    return {
      success: false,
      error: "Something went wrong. Please try again.",
    };
  }
};
