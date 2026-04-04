const MAX_INPUT_LENGTH = 2000;

const QUOTED_STRINGS = /['"`][^'"`]*['"`]/g;
const SCOPED_PACKAGES = /@[\w-]+\/[\w-]+/g;
const RELATIVE_IMPORTS = /['"`]\.\.?\/[^'"`]*['"`]/g;
const UNIX_PATHS = /(?:\/[\w.-]+)+(?:\/[\w.-]*)?/g;
const WINDOWS_PATHS = /[A-Z]:\\(?:[\w.-]+\\)+[\w.-]*/gi;
const NUMBERS_NOT_IN_CODES = /(?<![A-Z])\b\d+\b/g;
const WHITESPACE = /\s+/g;
const COMMON_PATH_PREFIXES = /^.*?(?=src\/|lib\/|app\/|packages\/|apps\/)/i;
const BACKSLASH = /\\/g;

const API_KEYS =
  /\b(?:api[_-]?key|token|secret|password|auth|bearer|credential)s?\s*[=:]\s*['"]?[\w-]{8,}['"]?/gi;
const JWT_TOKENS = /\beyJ[\w-]*\.[\w-]*\.[\w-]*/g;
const AWS_KEYS = /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g;
const HEX_TOKENS = /\b[a-fA-F0-9]{48,}\b/g;
const CONTEXTUAL_HEX =
  /(?:key|token|secret|password|auth|credential)s?\s*[=:]\s*[a-fA-F0-9]{16,}/gi;
const EMAIL_ADDRESSES = /\b[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g;
const IP_ADDRESSES = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const HOME_PATHS = /(?:\/Users\/|\/home\/|C:\\Users\\)[\w.-]+/gi;

const replaceSensitiveData = (input: string): string =>
  input
    .replace(API_KEYS, "<secret>")
    .replace(JWT_TOKENS, "<token>")
    .replace(AWS_KEYS, "<aws-key>")
    .replace(CONTEXTUAL_HEX, "<hex>")
    .replace(HEX_TOKENS, "<hex>")
    .replace(EMAIL_ADDRESSES, "<email>")
    .replace(IP_ADDRESSES, "<ip>")
    .replace(HOME_PATHS, "<home>");

export const normalizeForFingerprintMessage = (message: string): string => {
  const truncatedInput = message.slice(0, MAX_INPUT_LENGTH);

  return replaceSensitiveData(truncatedInput)
    .replace(QUOTED_STRINGS, "<string>")
    .replace(SCOPED_PACKAGES, "<module>")
    .replace(RELATIVE_IMPORTS, "<module>")
    .replace(UNIX_PATHS, "<path>")
    .replace(WINDOWS_PATHS, "<path>")
    .replace(NUMBERS_NOT_IN_CODES, "<n>")
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, 500);
};

const MAX_PATH_LENGTH = 1000;

export const normalizeFingerprintFilePath = (filePath: string): string => {
  const truncatedPath = filePath.slice(0, MAX_PATH_LENGTH);
  const unixPath = truncatedPath.replace(BACKSLASH, "/");
  const normalized = unixPath.replace(COMMON_PATH_PREFIXES, "");
  const result =
    normalized === unixPath ? unixPath.replace(HOME_PATHS, "") : normalized;

  return result.toLowerCase();
};
