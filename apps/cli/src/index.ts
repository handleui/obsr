#!/usr/bin/env node
import { runMain } from "citty";
import { main } from "./commands/index.js";
import { maybeAutoUpdate } from "./utils/auto-update.js";
import { getVersion } from "./utils/version.js";

// Injected at compile time for standalone binaries
declare const DETENT_PRODUCTION: boolean | undefined;

// Load .env only in development (compiled binaries have env vars baked in)
if (typeof DETENT_PRODUCTION === "undefined") {
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { config } = await import("dotenv");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  config({ path: resolve(__dirname, "..", ".env") });
}

// Auto-update check (non-blocking for cached results, applies update if available)
const args = process.argv.slice(2);
const updateResult = await maybeAutoUpdate({
  currentVersion: getVersion(),
  args,
});

// If we successfully updated, re-exec with the new binary
if (updateResult.updated) {
  const { spawn } = await import("node:child_process");
  const execPath = process.argv[0] ?? process.execPath;
  const child = spawn(execPath, process.argv.slice(1), {
    stdio: "inherit",
  });
  child.on("close", (code: number | null) => process.exit(code ?? 0));
} else {
  runMain(main);
}
