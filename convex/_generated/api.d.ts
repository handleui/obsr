/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as api_keys from "../api_keys.js";
import type * as commit_job_stats from "../commit_job_stats.js";
import type * as crons from "../crons.js";
import type * as enterprises from "../enterprises.js";
import type * as invitations from "../invitations.js";
import type * as jobs from "../jobs.js";
import type * as organization_members from "../organization_members.js";
import type * as organizations from "../organizations.js";
import type * as pr_comments from "../pr_comments.js";
import type * as projects from "../projects.js";
import type * as resolves from "../resolves.js";
import type * as service_auth from "../service_auth.js";
import type * as validators from "../validators.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  api_keys: typeof api_keys;
  commit_job_stats: typeof commit_job_stats;
  crons: typeof crons;
  enterprises: typeof enterprises;
  invitations: typeof invitations;
  jobs: typeof jobs;
  organization_members: typeof organization_members;
  organizations: typeof organizations;
  pr_comments: typeof pr_comments;
  projects: typeof projects;
  resolves: typeof resolves;
  service_auth: typeof service_auth;
  validators: typeof validators;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
