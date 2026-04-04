#!/usr/bin/env node
import { defineCommand, runMain } from "citty";

import { createCommand } from "./commands/create.js";
import { startCommand } from "./commands/start.js";
import { readCliVersion } from "./version.js";

const main = defineCommand({
  meta: {
    name: "dt",
    description: "Observer CLI — self-host scaffolding and Docker compose",
    version: readCliVersion(),
  },
  subCommands: {
    create: createCommand,
    start: startCommand,
  },
});

await runMain(main);
