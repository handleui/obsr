import "server-only";

import { ConvexHttpClient } from "convex/browser";
import type {
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";

import { api } from "../../../../convex/_generated/api";

type SecuredQueryRef = FunctionReference<
  "query",
  "public",
  { serviceToken?: string },
  unknown
>;
type SecuredMutationRef = FunctionReference<
  "mutation",
  "public",
  { serviceToken?: string },
  unknown
>;

/**
 * Queries that require service token authentication.
 *
 * SYNC REQUIREMENT: This set must match all Convex query functions that call
 * `requireServiceAuth` in convex/*.ts files. If a function is added to Convex
 * with requireServiceAuth but not listed here, it will fail at runtime.
 *
 * To verify sync:
 *   grep -r "requireServiceAuth" convex/*.ts
 *
 * Source files:
 *   - convex/api_keys.ts
 *   - convex/organizations.ts
 *   - convex/organization_members.ts
 *   - convex/projects.ts
 */
const securedQueries = new Set<SecuredQueryRef>([
  api.api_keys.getById,
  api.api_keys.getByKeyHash,
  api.api_keys.listByOrg,
  api.organizations.getById,
  api.organizations.getBySlug,
  api.organizations.getByProviderAccount,
  api.organizations.getByProviderAccountLogin,
  api.organizations.listByProviderAccountIds,
  api.organizations.listByInstallerGithubId,
  api.organizations.listByEnterprise,
  api.organizations.listByProviderInstallationId,
  api.organizations.list,
  api.organizations.listActiveGithub,
  api.organization_members.getByOrgUser,
  api.projects.getById,
  api.projects.listByOrg,
  api.projects.countByOrg,
  api.projects.getByOrgHandle,
  api.projects.getByOrgRepo,
  api.projects.getByRepoFullName,
  api.projects.getByRepoId,
  api.projects.listByRepoIds,
]);

/**
 * Mutations that require service token authentication.
 * See securedQueries for sync requirements.
 */
const securedMutations = new Set<SecuredMutationRef>([
  api.api_keys.create,
  api.api_keys.updateLastUsedAt,
  api.api_keys.update,
  api.api_keys.remove,
  api.organizations.create,
  api.organizations.update,
  api.organization_members.updateRole,
  api.projects.create,
  api.projects.update,
  api.projects.reactivate,
  api.projects.syncFromGitHub,
  api.projects.clearRemovedByOrg,
  api.projects.softDeleteByRepoIds,
]);

interface ConvexClientConfig {
  url: string;
  serviceToken?: string;
  authToken?: string;
}

const getConfig = (authToken?: string): ConvexClientConfig => {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is required");
  }
  return {
    url,
    serviceToken: process.env.CONVEX_SERVICE_TOKEN,
    authToken,
  };
};

let cachedClient: ConvexHttpClient | null = null;

// NOTE: Authenticated requests create a new ConvexHttpClient per request (no caching).
// This is intentional: ConvexHttpClient is stateful (holds credentials, queues mutations)
// so sharing instances across different auth tokens would be incorrect. The underlying
// HTTP connections are still pooled at the runtime level (Node.js undici/fetch), so
// TCP connection reuse happens automatically.
const createClient = (config: ConvexClientConfig): ConvexHttpClient => {
  if (config.authToken) {
    const authedClient = new ConvexHttpClient(config.url);
    authedClient.setAuth(config.authToken);
    return authedClient;
  }

  if (cachedClient) {
    return cachedClient;
  }

  const client = new ConvexHttpClient(config.url);
  cachedClient = client;
  return client;
};

export interface TypedConvexClient {
  query: <Query extends FunctionReference<"query">>(
    queryRef: Query,
    ...args: OptionalRestArgs<Query>
  ) => Promise<FunctionReturnType<Query>>;

  mutation: <Mutation extends FunctionReference<"mutation">>(
    mutationRef: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ) => Promise<FunctionReturnType<Mutation>>;
}

export const getConvexClient = (authToken?: string): TypedConvexClient => {
  const config = getConfig(authToken);
  const client = createClient(config);

  const query = <Query extends FunctionReference<"query">>(
    queryRef: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> => {
    const queryArgs = args[0] ?? {};

    if (
      config.serviceToken &&
      !config.authToken &&
      securedQueries.has(queryRef as unknown as SecuredQueryRef)
    ) {
      return client.query(queryRef, {
        ...queryArgs,
        serviceToken: config.serviceToken,
      } as OptionalRestArgs<Query>[0]);
    }

    return client.query(queryRef, ...args);
  };

  const mutation = <Mutation extends FunctionReference<"mutation">>(
    mutationRef: Mutation,
    ...args: OptionalRestArgs<Mutation>
  ): Promise<FunctionReturnType<Mutation>> => {
    const mutationArgs = args[0] ?? {};

    if (
      config.serviceToken &&
      !config.authToken &&
      securedMutations.has(mutationRef as unknown as SecuredMutationRef)
    ) {
      return client.mutation(mutationRef, {
        ...mutationArgs,
        serviceToken: config.serviceToken,
      } as OptionalRestArgs<Mutation>[0]);
    }

    return client.mutation(mutationRef, ...args);
  };

  return { query, mutation };
};

export const toIsoString = (value: number | null | undefined): string | null =>
  value === undefined || value === null ? null : new Date(value).toISOString();
