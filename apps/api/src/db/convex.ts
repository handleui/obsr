import { ConvexHttpClient } from "convex/browser";
import type { Env } from "../types/env";

const securedFunctions = new Set([
  "api_keys:create",
  "api_keys:getById",
  "api_keys:getByKeyHash",
  "api_keys:listByOrg",
  "api_keys:updateLastUsedAt",
  "api_keys:update",
  "api_keys:remove",
  "heals:create",
  "heals:get",
  "heals:getByPr",
  "heals:getByProjectStatus",
  "heals:getActiveByProject",
  "heals:getByRunId",
  "heals:getPending",
  "heals:updateStatus",
  "heals:apply",
  "heals:reject",
  "heals:trigger",
  "heals:setCheckRunId",
  "heals:markStaleAsFailed",
  "organizations:create",
  "organizations:getById",
  "organizations:getBySlug",
  "organizations:getByProviderAccount",
  "organizations:getByProviderAccountLogin",
  "organizations:listByProviderAccountIds",
  "organizations:listByInstallerGithubId",
  "organizations:listByEnterprise",
  "organizations:listByProviderInstallationId",
  "organizations:list",
  "organizations:listActiveGithub",
  "organizations:update",
  "organization_members:updateRole",
  "projects:create",
  "projects:getById",
  "projects:listByOrg",
  "projects:countByOrg",
  "projects:getByOrgHandle",
  "projects:getByOrgRepo",
  "projects:getByRepoFullName",
  "projects:getByRepoId",
  "projects:listByRepoIds",
  "projects:update",
  "projects:reactivate",
  "projects:syncFromGitHub",
  "projects:clearRemovedByOrg",
  "projects:softDeleteByRepoIds",
]);

const withServiceToken = (
  args: Record<string, unknown> | undefined,
  serviceToken: string
): Record<string, unknown> => ({
  ...(args ?? {}),
  serviceToken,
});

type ConvexMethod = (
  name: string,
  args?: Record<string, unknown>
) => Promise<unknown>;

const wrapWithServiceToken =
  (baseFn: ConvexMethod, serviceToken: string): ConvexMethod =>
  (name: string, args?: Record<string, unknown>) => {
    if (!securedFunctions.has(name)) {
      return baseFn(name, args);
    }
    return baseFn(
      name,
      withServiceToken(
        args as Record<string, unknown> | undefined,
        serviceToken
      )
    );
  };

export const getConvexClient = (env: Env): ConvexHttpClient => {
  const url = env.CONVEX_URL;
  if (!url) {
    throw new Error("CONVEX_URL is required");
  }

  const client = new ConvexHttpClient(url);
  const serviceToken = env.CONVEX_SERVICE_TOKEN;
  if (!serviceToken) {
    return client;
  }

  client.query = wrapWithServiceToken(
    client.query.bind(client) as unknown as ConvexMethod,
    serviceToken
  ) as unknown as ConvexHttpClient["query"];

  client.mutation = wrapWithServiceToken(
    client.mutation.bind(client) as unknown as ConvexMethod,
    serviceToken
  ) as unknown as ConvexHttpClient["mutation"];

  return client;
};

export const toIsoString = (value: number | undefined): string | null => {
  if (value === undefined) {
    return null;
  }
  return new Date(value).toISOString();
};
