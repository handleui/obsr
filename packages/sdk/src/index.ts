export { createClient, DetentClient } from "./client.js";
export * from "./errors.js";
export * from "./types.js";
export { sanitizeCredentials, CREDENTIAL_PATTERNS } from "./utils/sanitize.js";

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
export { WebhooksResource } from "./resources/webhooks.js";
export {
  verifyWebhookSignature,
  type VerifyWebhookOptions,
} from "./utils/verify-webhook.js";
