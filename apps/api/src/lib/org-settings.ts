// Organization settings and provider slug helpers (extracted from Postgres schema).

export interface OrganizationSettings {
  enableInlineAnnotations?: boolean;
  enablePrComments?: boolean;
  autofixEnabled?: boolean;
  autofixAutoCommit?: boolean;
  healEnabled?: boolean;
  healAutoCommit?: boolean;
  healAutoTrigger?: boolean;
  healBudgetPerRunUsd?: number;
}

export const DEFAULT_ORG_SETTINGS: Required<OrganizationSettings> = {
  enableInlineAnnotations: true,
  enablePrComments: true,
  autofixEnabled: true,
  autofixAutoCommit: false,
  healEnabled: false,
  healAutoCommit: false,
  healAutoTrigger: false,
  healBudgetPerRunUsd: 100,
};

export const getOrgSettings = (
  settings: OrganizationSettings | null | undefined
): Required<OrganizationSettings> => ({
  enableInlineAnnotations:
    settings?.enableInlineAnnotations ??
    DEFAULT_ORG_SETTINGS.enableInlineAnnotations,
  enablePrComments:
    settings?.enablePrComments ?? DEFAULT_ORG_SETTINGS.enablePrComments,
  autofixEnabled:
    settings?.autofixEnabled ?? DEFAULT_ORG_SETTINGS.autofixEnabled,
  autofixAutoCommit:
    settings?.autofixAutoCommit ?? DEFAULT_ORG_SETTINGS.autofixAutoCommit,
  healEnabled: settings?.healEnabled ?? DEFAULT_ORG_SETTINGS.healEnabled,
  healAutoCommit:
    settings?.healAutoCommit ?? DEFAULT_ORG_SETTINGS.healAutoCommit,
  healAutoTrigger:
    settings?.healAutoTrigger ?? DEFAULT_ORG_SETTINGS.healAutoTrigger,
  healBudgetPerRunUsd:
    settings?.healBudgetPerRunUsd ?? DEFAULT_ORG_SETTINGS.healBudgetPerRunUsd,
});

export const providerShortCodes: Record<"github" | "gitlab", string> = {
  github: "gh",
  gitlab: "gl",
};

export const createProviderSlug = (
  provider: "github" | "gitlab",
  login: string
): string => `${providerShortCodes[provider]}/${login.toLowerCase()}`;
