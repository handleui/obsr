/** E2B template presets for common use cases */
export const TEMPLATES = {
  /** Minimal base template */
  BASE: "base",
  /** Python 3.11 - default for AI code execution */
  PYTHON: "python-3.11",
  /** Node.js 20 for JavaScript/TypeScript */
  NODE: "node-20",
} as const;

/** Default timeout values in seconds */
export const DEFAULTS = {
  /** Sandbox lifetime (5 minutes) */
  SANDBOX_TIMEOUT: 300,
  /** Shell command timeout (1 minute) */
  COMMAND_TIMEOUT: 60,
  /** Code execution timeout (30 seconds) */
  CODE_TIMEOUT: 30,
} as const;

/** Default template for new sandboxes */
export const DEFAULT_TEMPLATE = TEMPLATES.PYTHON;
