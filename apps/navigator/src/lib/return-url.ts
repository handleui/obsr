// Regex for blocking control characters in URLs (defined at top level for performance)
// biome-ignore lint/suspicious/noControlCharactersInRegex: Intentionally blocking control chars for security
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/;

/**
 * Validate returnTo URL to prevent open redirect vulnerabilities
 *
 * Only allows safe relative paths:
 * - Must start with a single "/" (relative path)
 * - Must NOT start with "//" (protocol-relative URL → open redirect)
 * - Must NOT contain ":" before first "/" (blocks http:, https:, javascript:, etc.)
 * - Must NOT contain null bytes or control characters
 *
 * This is a type guard that narrows the type to `string` when returning `true`.
 *
 * @example
 * isValidReturnUrl("/dashboard")           // true
 * isValidReturnUrl("/settings?tab=profile") // true
 * isValidReturnUrl("https://evil.com")     // false
 * isValidReturnUrl("//evil.com")           // false
 * isValidReturnUrl("javascript:alert(1)")  // false
 */
export const isValidReturnUrl = (
  url: string | null | undefined
): url is string => {
  if (!url || typeof url !== "string") {
    return false;
  }

  if (CONTROL_CHAR_REGEX.test(url)) {
    return false;
  }

  if (!url.startsWith("/")) {
    return false;
  }

  if (url.startsWith("//")) {
    return false;
  }

  if (url.includes("\\")) {
    return false;
  }

  const colonIndex = url.indexOf(":");
  const slashIndex = url.indexOf("/", 1);
  if (colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)) {
    return false;
  }

  return true;
};

/**
 * Sanitize returnTo URL - returns the URL if valid, otherwise returns fallback
 */
export const sanitizeReturnUrl = (
  url: string | null | undefined,
  fallback = "/"
): string => {
  return isValidReturnUrl(url) ? url : fallback;
};
