import { forbidden } from "next/navigation";
import { API_BASE_URL } from "@/lib/constants";
import { fetchOrg, isOrgAdmin } from "@/lib/dal";
import { getWorkOSAccessToken } from "@/lib/workos-session";
import ApiKeysSection from "./api-keys-section";

interface OrgSettingsPageProps {
  params: Promise<{
    provider: string;
    org: string;
  }>;
}

interface ApiKeyResponse {
  api_keys: Array<{
    id: string;
    key_prefix: string;
    name: string;
    created_at: string;
    last_used_at: string | null;
  }>;
}

const fetchApiKeys = async (
  orgId: string
): Promise<ApiKeyResponse["api_keys"]> => {
  const token = await getWorkOSAccessToken();
  if (!token) {
    return [];
  }

  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/orgs/${encodeURIComponent(orgId)}/api-keys`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      }
    );
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as ApiKeyResponse;
    return data.api_keys;
  } catch {
    return [];
  }
};

const OrgSettingsPage = async ({ params }: OrgSettingsPageProps) => {
  const { provider, org } = await params;

  const hasAccess = await isOrgAdmin(provider, org);
  if (!hasAccess) {
    forbidden();
  }

  const orgData = await fetchOrg(provider, org);
  if (!orgData) {
    forbidden();
  }

  const keys = await fetchApiKeys(orgData.id);

  return (
    <div className="p-6">
      <h1 className="mb-6 font-bold text-2xl">Settings</h1>

      <section>
        <h2 className="mb-4 font-medium text-lg text-neutral-900">API Keys</h2>
        <p className="mb-4 text-neutral-500 text-sm">
          Create keys to access the Observer API from external services. Keys
          use the{" "}
          <code className="rounded bg-neutral-100 px-1 font-mono text-xs">
            dtk_
          </code>{" "}
          prefix.
        </p>
        <ApiKeysSection keys={keys} org={org} provider={provider} />
      </section>
    </div>
  );
};

export default OrgSettingsPage;
