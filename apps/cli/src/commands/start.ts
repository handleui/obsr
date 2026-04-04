import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { execa } from "execa";
import pc from "picocolors";

import { assertComposeFileAllowed } from "../lib/path-safety.js";

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Run docker compose up for the Observer stack (Postgres + web)",
  },
  args: {
    file: {
      type: "string",
      description: "Compose file path",
      alias: "f",
      default: "compose.yaml",
    },
    detach: {
      type: "boolean",
      description: "Run containers in the background",
      alias: "d",
      default: false,
    },
    allowOutside: {
      type: "boolean",
      description:
        "Allow compose file outside the current working directory (unsafe if misused)",
      default: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const composeFile = resolve(cwd, args.file);
    try {
      assertComposeFileAllowed(cwd, composeFile, args.allowOutside);
    } catch (error) {
      consola.error(pc.red((error as Error).message));
      process.exitCode = 1;
      return;
    }

    if (!existsSync(composeFile)) {
      consola.error(
        pc.red(
          `Compose file not found: ${composeFile}. Run ${pc.bold("dt create")} or use an existing compose.yaml at the repository root.`
        )
      );
      process.exitCode = 1;
      return;
    }

    const composeArgs = ["compose", "-f", composeFile, "up"];
    if (args.detach) {
      composeArgs.push("-d");
    }

    consola.info(pc.cyan(`Running: docker ${composeArgs.join(" ")}`));
    consola.info(
      pc.dim(
        "Ensure Docker is running. App: http://localhost:3000 (after image build)."
      )
    );

    try {
      await execa("docker", composeArgs, {
        stdio: "inherit",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      consola.error(pc.red(`docker compose failed: ${message}`));
      process.exitCode = 1;
    }
  },
});
