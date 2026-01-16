import type { Polar } from "@polar-sh/sdk";
import { Polar as PolarClient } from "@polar-sh/sdk";
import type { Env } from "../types/env.js";

// ============================================================================
// Types
// ============================================================================

interface UsageEvent {
  name: string;
  externalCustomerId: string;
  metadata?: Record<string, string | number | boolean>;
}

interface PolarCustomer {
  id: string;
  externalId: string | null;
  email: string;
  name: string | null;
}

// ============================================================================
// Error Messages
// ============================================================================

const ERROR_MESSAGES = {
  MISSING_ACCESS_TOKEN: "POLAR_ACCESS_TOKEN not configured",
  MISSING_ORG_ID: "POLAR_ORGANIZATION_ID not configured",
} as const;

// ============================================================================
// Client Factory
// ============================================================================

export const createPolarClient = (env: Env): Polar => {
  const accessToken = env.POLAR_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(ERROR_MESSAGES.MISSING_ACCESS_TOKEN);
  }
  return new PolarClient({ accessToken });
};

export const getPolarOrgId = (env: Env): string => {
  const orgId = env.POLAR_ORGANIZATION_ID;
  if (!orgId) {
    throw new Error(ERROR_MESSAGES.MISSING_ORG_ID);
  }
  return orgId;
};

// ============================================================================
// Customer Operations
// ============================================================================

export const createPolarCustomer = async (
  polar: Polar,
  polarOrgId: string,
  detentOrgId: string,
  email: string,
  name?: string
): Promise<PolarCustomer> => {
  const customer = await polar.customers.create({
    externalId: detentOrgId,
    email,
    name,
    organizationId: polarOrgId,
  });
  return customer as PolarCustomer;
};

export const getCustomerByExternalId = async (
  polar: Polar,
  polarOrgId: string,
  externalId: string
): Promise<PolarCustomer | null> => {
  const result = await polar.customers.list({
    organizationId: polarOrgId,
    query: externalId,
  });
  const customer = result.result.items.find((c) => c.externalId === externalId);
  return (customer as PolarCustomer) ?? null;
};

// ============================================================================
// Usage Tracking
// ============================================================================

export const ingestUsageEvents = async (
  polar: Polar,
  events: UsageEvent[]
): Promise<void> => {
  if (events.length === 0) {
    return;
  }

  await polar.events.ingest({
    events: events.map((e) => ({
      name: e.name,
      externalCustomerId: e.externalCustomerId,
      metadata: e.metadata,
    })),
  });
};

// ============================================================================
// Customer Portal
// ============================================================================

export const createCustomerPortalSession = async (
  polar: Polar,
  customerId: string
): Promise<string> => {
  const session = await polar.customerSessions.create({ customerId });
  return session.customerPortalUrl;
};
