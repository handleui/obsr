/**
 * @detent/sdk
 *
 * TypeScript SDK for the Detent API.
 *
 * @example
 * ```typescript
 * import { createClient } from '@detent/sdk';
 *
 * const client = createClient({
 *   auth: { type: 'apiKey', token: 'dtk_...' }
 * });
 *
 * // Get errors for a commit
 * const errors = await client.errors.get('abc123', 'owner/repo');
 *
 * // List projects
 * const projects = await client.projects.list('org_id');
 * ```
 */

export { createClient, DetentClient } from "./client.js";
export * from "./errors.js";
export * from "./types.js";
export { sanitizeCredentials, CREDENTIAL_PATTERNS } from "./utils/sanitize.js";

// Re-export resource classes for advanced use cases
export { AuthResource } from "./resources/auth.js";
export { ErrorsResource } from "./resources/errors.js";
export { HealsResource } from "./resources/heals.js";
export { InvitationsResource } from "./resources/invitations.js";
export { MembersResource } from "./resources/members.js";
export {
  OrganizationsResource,
  type OrganizationStatusResponse,
} from "./resources/organizations.js";
export { ProjectsResource } from "./resources/projects.js";
