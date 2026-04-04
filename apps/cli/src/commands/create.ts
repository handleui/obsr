import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { resolvePathUnderCwd } from "../lib/path-safety.js";
import { readCliVersion } from "../version.js";

const templateDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../templates"
);

export const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Scaffold compose.yaml and .env.selfhost.example for local self-host",
  },
  args: {
    dir: {
      type: "positional",
      description: "Target directory (default: current directory)",
      required: false,
      default: ".",
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    const version = readCliVersion();
    const rawDir = typeof args.dir === "string" ? args.dir : ".";
    let targetDir: string;
    try {
      targetDir = rawDir === "." ? cwd : resolvePathUnderCwd(cwd, rawDir);
    } catch (error) {
      consola.error(pc.red((error as Error).message));
      process.exitCode = 1;
      return;
    }

    try {
      await mkdir(targetDir, { recursive: true });
      const compose = await readTemplateFile("compose.yaml");
      const envExample = await readTemplateFile("env.selfhost.example");
      await writeFile(join(targetDir, "compose.yaml"), compose, "utf8");
      await writeFile(
        join(targetDir, ".env.selfhost.example"),
        envExample,
        "utf8"
      );
    } catch (error) {
      consola.error(
        pc.red(`Failed to write scaffold: ${(error as Error).message}`)
      );
      process.exitCode = 1;
      return;
    }

    consola.success(
      pc.green(`Observer self-host files written to ${pc.bold(targetDir)}`)
    );
    consola.info(`CLI version ${version}`);
    consola.info(
      "Copy .env.selfhost.example to .env.selfhost, set secrets, then run from the Observer repo root: dt start --file compose.yaml"
    );
  },
});

const readTemplateFile = (name: string): Promise<string> => {
  const path = join(templateDir, name);
  return readFile(path, "utf8");
};
