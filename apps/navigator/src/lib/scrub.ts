/**
 * Re-exports scrubbing utilities from @detent/sentry
 * Maintained for backward compatibility with existing imports
 */
// biome-ignore lint/performance/noBarrelFile: Re-export shim for backward compat
export {
  SENSITIVE_KEYS,
  SENSITIVE_PATTERNS,
  scrubObject,
  scrubString,
  scrubStringNullable,
} from "@detent/sentry";
