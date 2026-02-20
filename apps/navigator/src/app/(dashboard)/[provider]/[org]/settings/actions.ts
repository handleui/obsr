"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { API_BASE_URL } from "@/lib/constants";
import { isOrgAdmin } from "@/lib/dal";
import { getWorkOSAccessToken } from "@/lib/workos-session";

export interface ActionState {
  error?: string;
  key?: string;
  keyName?: string;
}

/** Only alphanumeric, hyphens, underscores — rejects path traversal */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const isSafePathSegment = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && SAFE_ID.test(value);

const getAuthHeaders = async (): Promise<Headers> => {
  const token = await getWorkOSAccessToken();
  if (!token) {
    redirect("/login");
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  return headers;
};

const mapError = (status: number, fallback: string): string => {
  if (status === 401) {
    return "SESSION_EXPIRED";
  }
  if (status === 404) {
    return "Key already revoked";
  }
  if (status === 429) {
    return "Rate limited — try again shortly";
  }
  return fallback;
};

/**
 * Verify the caller is an admin of the org identified by the provider/org
 * route segments, and return the canonical orgId from the DAL (not from
 * the client form). This prevents cross-org access via hidden-field tampering.
 */
interface AuthSuccess {
  orgId: string;
  pathPrefix: string;
}

interface AuthFailure {
  error: string;
}

const authorizeOrg = async (
  formData: FormData
): Promise<AuthSuccess | AuthFailure> => {
  const provider = formData.get("provider") as string;
  const org = formData.get("org") as string;

  if (!(isSafePathSegment(provider) && isSafePathSegment(org))) {
    return { error: "Invalid parameters" };
  }

  const hasAccess = await isOrgAdmin(provider, org);
  if (!hasAccess) {
    return { error: "Unauthorized" };
  }

  // Re-fetch the org to get the canonical DB id — never trust client-supplied orgId
  const { fetchOrg } = await import("@/lib/dal");
  const orgData = await fetchOrg(provider, org);
  if (!orgData) {
    return { error: "Organization not found" };
  }

  return {
    orgId: orgData.id,
    pathPrefix: `/${provider}/${org}/settings`,
  };
};

export const createApiKey = async (
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> => {
  const authResult = await authorizeOrg(formData);
  if ("error" in authResult) {
    return authResult;
  }
  const { orgId, pathPrefix } = authResult;

  const name = (formData.get("name") as string)?.trim();
  if (!name) {
    return { error: "Name is required" };
  }

  const headers = await getAuthHeaders();

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE_URL}/v1/orgs/${encodeURIComponent(orgId)}/api-keys`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ name }),
      }
    );
  } catch {
    return { error: "Connection failed" };
  }

  if (!res.ok) {
    const err = mapError(res.status, "Failed to create key");
    if (err === "SESSION_EXPIRED") {
      redirect("/login");
    }
    return { error: err };
  }

  const data = (await res.json()) as { key: string; name: string };
  revalidatePath(pathPrefix);
  return { key: data.key, keyName: data.name };
};

export const revokeApiKey = async (
  _prev: ActionState | null,
  formData: FormData
): Promise<ActionState> => {
  const authResult = await authorizeOrg(formData);
  if ("error" in authResult) {
    return authResult;
  }
  const { orgId, pathPrefix } = authResult;

  const keyId = formData.get("keyId") as string;
  if (!isSafePathSegment(keyId)) {
    return { error: "Invalid key" };
  }

  const headers = await getAuthHeaders();

  let res: Response;
  try {
    res = await fetch(
      `${API_BASE_URL}/v1/orgs/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(keyId)}`,
      { method: "DELETE", headers }
    );
  } catch {
    return { error: "Connection failed" };
  }

  if (!res.ok) {
    const err = mapError(res.status, "Failed to revoke key");
    if (err === "SESSION_EXPIRED") {
      redirect("/login");
    }
    return { error: err };
  }

  revalidatePath(pathPrefix);
  return {};
};
