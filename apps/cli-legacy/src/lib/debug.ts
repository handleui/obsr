const DEBUG_TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const isDebugEnabled = (): boolean => {
  const value = process.env.DEBUG?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  return DEBUG_TRUE_VALUES.has(value);
};
