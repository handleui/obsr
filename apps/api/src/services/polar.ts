import type { Polar } from "@polar-sh/sdk";
import { Polar as PolarClient } from "@polar-sh/sdk";
import { ResourceNotFound } from "@polar-sh/sdk/models/errors/resourcenotfound.js";
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
  externalId: string
): Promise<PolarCustomer | null> => {
  try {
    const customer = await polar.customers.getExternal({ externalId });
    return customer as PolarCustomer;
  } catch (error) {
    if (error instanceof ResourceNotFound) {
      return null;
    }
    throw error;
  }
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
// Subscription Management
// ============================================================================

// Cancel all active subscriptions for a customer (at period end)
export const cancelCustomerSubscriptions = async (
  polar: Polar,
  polarOrgId: string,
  customerId: string
): Promise<number> => {
  // List active subscriptions for this customer
  const subscriptions = await polar.subscriptions.list({
    organizationId: polarOrgId,
    customerId,
    active: true,
  });

  let canceledCount = 0;
  for (const sub of subscriptions.result.items) {
    try {
      await polar.subscriptions.update({
        id: sub.id,
        subscriptionUpdate: {
          cancelAtPeriodEnd: true,
        },
      });
      canceledCount++;
    } catch (error) {
      // Log but continue - subscription may already be canceled
      console.warn(`[polar] Failed to cancel subscription ${sub.id}:`, error);
    }
  }

  return canceledCount;
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

// ============================================================================
// Customer State (for billing/entitlement checks)
// ============================================================================

interface CustomerStateMeter {
  meterId: string;
  consumedUnits: number;
  creditedUnits: number;
  balance: number;
}

interface CustomerStateSubscription {
  id: string;
  status: string;
}

export interface CustomerState {
  activeSubscriptions: CustomerStateSubscription[];
  activeMeters: CustomerStateMeter[];
}

// Get customer state by external ID (detent org ID) - includes subscriptions and meter balances
export const getCustomerStateByExternalId = async (
  polar: Polar,
  externalId: string
): Promise<CustomerState | null> => {
  try {
    const state = await polar.customers.getStateExternal({ externalId });
    return {
      activeSubscriptions: (state.activeSubscriptions ?? []).map((s) => ({
        id: s.id,
        status: s.status,
      })),
      activeMeters: (state.activeMeters ?? []).map((m) => ({
        meterId: m.meterId,
        consumedUnits: m.consumedUnits,
        creditedUnits: m.creditedUnits,
        balance: m.balance,
      })),
    };
  } catch (error) {
    // Customer not found in Polar - use SDK typed error for reliable detection
    if (error instanceof ResourceNotFound) {
      return null;
    }
    throw error;
  }
};
