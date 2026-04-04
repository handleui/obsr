import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const OBSR_CLI_VERSION: string | undefined;

export const readCliVersion = (): string => {
  if (typeof OBSR_CLI_VERSION === "string" && OBSR_CLI_VERSION.length > 0) {
    return OBSR_CLI_VERSION;
  }
  const path = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { version: string };
  return pkg.version;
};
