import type { ExtractedError } from "../types.js";

const normalizeMessage = (msg: string): string =>
  msg
    .replace(/['"`][\w./-]+['"`]/g, "<path>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

export const generateSignature = (error: ExtractedError): string => {
  const parts = [
    error.category ?? "unknown",
    error.source ?? "unknown",
    error.ruleId ?? "",
    normalizeMessage(error.message),
  ];
  return parts.join(":");
};
