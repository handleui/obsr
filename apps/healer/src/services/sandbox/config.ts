export const TEMPLATES = {
  BASE: "base",
  PYTHON: "python-3.11",
  NODE: "node-20",
} as const;

export const DEFAULTS = {
  SANDBOX_TIMEOUT: 300,
  COMMAND_TIMEOUT: 60,
  CODE_TIMEOUT: 30,
} as const;

export const DEFAULT_TEMPLATE = TEMPLATES.PYTHON;
