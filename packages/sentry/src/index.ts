// biome-ignore-all lint/performance/noBarrelFile: This is the package's public API

// Event utilities
export {
  createBeforeSendHandler,
  createBeforeSendTransactionHandler,
  scrubBreadcrumb,
  scrubEvent,
  scrubReplayEvent,
  scrubRequest,
  scrubRequestData,
  scrubUser,
} from "./event.js";

// Header utilities
export {
  isSensitiveHeader,
  SENSITIVE_HEADERS,
  scrubHeaders,
} from "./headers.js";

// Core scrubbing utilities
export {
  isSensitiveKey,
  SENSITIVE_KEYS,
  SENSITIVE_PATTERNS,
  scrubObject,
  scrubString,
  scrubStringNullable,
} from "./scrub.js";

// Types
export type {
  SentryBreadcrumb,
  SentryEvent,
  SentryRequest,
  SentryUser,
} from "./types.js";
