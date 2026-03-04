// Organization settings and provider slug helpers (extracted from Postgres schema).

export interface OrganizationSettings {
  enableInlineAnnotations?: boolean;
  enablePrComments?: boolean;
  autofixEnabled?: boolean;
  autofixAutoCommit?: boolean;
  resolveAutoCommit?: boolean;
  resolveAutoTrigger?: boolean;
  resolveBudgetPerRunUsd?: number;
  validationEnabled?: boolean;
}

export const DEFAULT_ORG_SETTINGS: Required<OrganizationSettings> = {
  enableInlineAnnotations: true,
  enablePrComments: true,
  autofixEnabled: true,
  autofixAutoCommit: false,
  resolveAutoCommit: false,
  resolveAutoTrigger: false,
  resolveBudgetPerRunUsd: 100,
  validationEnabled: false,
};

export const getOrgSettings = (
  settings: OrganizationSettings | null | undefined
): Required<OrganizationSettings> => {
  if (!settings) {
    return { ...DEFAULT_ORG_SETTINGS };
  }

  // Filter out undefined/null values before spreading so defaults are preserved
  const defined = Object.fromEntries(
    Object.entries(settings).filter(([, v]) => v != null)
  );
  return { ...DEFAULT_ORG_SETTINGS, ...defined };
};

export const providerShortCodes: Record<"github" | "gitlab", string> = {
  github: "gh",
  gitlab: "gl",
};

export const createProviderSlug = (
  provider: "github" | "gitlab",
  login: string
): string => `${providerShortCodes[provider]}/${login.toLowerCase()}`;
