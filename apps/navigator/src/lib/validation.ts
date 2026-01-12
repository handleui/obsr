/** Token format regex - alphanumeric with hyphens/underscores, 8-128 chars */
const TOKEN_FORMAT_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Validate invitation token format
 * Tokens should be alphanumeric with hyphens/underscores, reasonable length
 * This prevents injection attacks and ensures safe URL construction
 */
export const isValidTokenFormat = (token: string): boolean =>
  TOKEN_FORMAT_REGEX.test(token);
