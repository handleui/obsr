/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiKeys from "../api-keys.js";
import type * as commitJobStats from "../commit-job-stats.js";
import type * as enterprises from "../enterprises.js";
import type * as errorOccurrences from "../error-occurrences.js";
import type * as errorSignatures from "../error-signatures.js";
import type * as heals from "../heals.js";
import type * as invitations from "../invitations.js";
import type * as jobs from "../jobs.js";
import type * as organizationMembers from "../organization-members.js";
import type * as organizations from "../organizations.js";
import type * as prComments from "../pr-comments.js";
import type * as projects from "../projects.js";
import type * as runErrors from "../run-errors.js";
import type * as runIngest from "../run-ingest.js";
import type * as runs from "../runs.js";
import type * as usageEvents from "../usage-events.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "api-keys": typeof apiKeys;
  "commit-job-stats": typeof commitJobStats;
  enterprises: typeof enterprises;
  "error-occurrences": typeof errorOccurrences;
  "error-signatures": typeof errorSignatures;
  heals: typeof heals;
  invitations: typeof invitations;
  jobs: typeof jobs;
  "organization-members": typeof organizationMembers;
  organizations: typeof organizations;
  "pr-comments": typeof prComments;
  projects: typeof projects;
  "run-errors": typeof runErrors;
  "run-ingest": typeof runIngest;
  runs: typeof runs;
  "usage-events": typeof usageEvents;
  validators: typeof validators;
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
