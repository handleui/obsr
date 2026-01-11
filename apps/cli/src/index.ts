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

// Auto-update only runs in production builds (standalone binaries)
// In production, process.argv[0] IS the binary path (e.g., ~/.local/bin/dt)
// In development, process.argv[0] is the node/bun executable, so re-exec wouldn't work
const isProduction = typeof DETENT_PRODUCTION !== "undefined";
const args = process.argv.slice(2);

if (isProduction) {
  const updateResult = await maybeAutoUpdate({
    currentVersion: getVersion(),
    args,
  });

  // If we successfully updated, re-exec with the new binary
  // process.argv[0] is the standalone binary path in production
  if (updateResult.updated) {
    const { spawn } = await import("node:child_process");
    const binaryPath = process.argv[0];
    if (binaryPath) {
      const child = spawn(binaryPath, args, { stdio: "inherit" });
      child.on("close", (code: number | null) => process.exit(code ?? 0));
      child.on("error", (err) => {
        console.error(`Failed to restart with updated binary: ${err.message}`);
        process.exit(1);
      });
    } else {
      runMain(main);
    }
  } else {
    runMain(main);
  }
} else {
  runMain(main);
}
