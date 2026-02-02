/**
 * Input validation utilities for API routes
 *
 * Provides validation for slugs, handles, and other user inputs
 * to prevent injection attacks and ensure data consistency.
 */

// Valid slug/handle pattern: lowercase alphanumeric with hyphens, no leading/trailing hyphens
// Allows forward slash for provider-prefixed slugs (e.g., gh/org-name)
const SLUG_PATTERN = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

// Handle pattern: derived from GitHub/GitLab repo names (alphanumeric, hyphens, underscores, dots)
// Must start with alphanumeric, max 100 chars (GitHub repo name limit)
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Provider values
const VALID_PROVIDERS = ["github", "gitlab"] as const;

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a slug (e.g., organization slug like "gh/my-org")
 * - Must be 1-255 characters
 * - Lowercase alphanumeric with hyphens and optional forward slash
 * - No leading/trailing hyphens or slashes
 * - No consecutive hyphens or slashes
 */
export const validateSlug = (
  slug: string,
  fieldName = "slug"
): ValidationResult => {
  if (!slug || typeof slug !== "string") {
    return { valid: false, error: `${fieldName} is required` };
  }

  const trimmed = slug.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  if (trimmed.length > 255) {
    return {
      valid: false,
      error: `${fieldName} must be 255 characters or less`,
    };
  }

  if (!SLUG_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} must contain only lowercase letters, numbers, hyphens, and forward slashes`,
    };
  }

  return { valid: true };
};

/**
 * Validate a handle (e.g., project handle like "my-project" or "my_project.v2")
 * - Must be 1-255 characters
 * - Lowercase alphanumeric with hyphens, underscores, and dots
 * - Must start with a letter or number
 */
export const validateHandle = (
  handle: string,
  fieldName = "handle"
): ValidationResult => {
  if (!handle || typeof handle !== "string") {
    return { valid: false, error: `${fieldName} is required` };
  }

  const trimmed = handle.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  if (trimmed.length > 255) {
    return {
      valid: false,
      error: `${fieldName} must be 255 characters or less`,
    };
  }

  if (!HANDLE_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} must start with a letter or number and contain only lowercase letters, numbers, hyphens, underscores, and dots`,
    };
  }

  return { valid: true };
};

/**
 * Validate a provider value
 */
export const validateProvider = (
  provider: string,
  fieldName = "provider"
): ValidationResult => {
  if (!provider || typeof provider !== "string") {
    return { valid: false, error: `${fieldName} is required` };
  }

  if (!VALID_PROVIDERS.includes(provider as (typeof VALID_PROVIDERS)[number])) {
    return {
      valid: false,
      error: `${fieldName} must be one of: ${VALID_PROVIDERS.join(", ")}`,
    };
  }

  return { valid: true };
};

/**
 * Sanitize a string for use as a handle
 * Converts to lowercase and replaces invalid characters with hyphens
 * Preserves underscores and dots (valid in GitHub/GitLab repo names)
 */
export const sanitizeHandle = (input: string): string => {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-") // Replace invalid chars with hyphens
    .replace(/-+/g, "-") // Collapse multiple hyphens
    .replace(/^[-._]+|[-._]+$/g, ""); // Remove leading/trailing special chars
};

// Email validation pattern (RFC 5322 simplified)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate an email address
 */
export const validateEmail = (
  email: string,
  fieldName = "email"
): ValidationResult => {
  if (!email || typeof email !== "string") {
    return { valid: false, error: `${fieldName} is required` };
  }

  const trimmed = email.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} cannot be empty` };
  }

  if (trimmed.length > 255) {
    return {
      valid: false,
      error: `${fieldName} must be 255 characters or less`,
    };
  }

  if (!EMAIL_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: `${fieldName} must be a valid email address`,
    };
  }

  return { valid: true };
};
