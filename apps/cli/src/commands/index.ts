import { defineCommand } from "citty";
import { getVersion } from "../utils/version.js";

export const main = defineCommand({
  meta: {
    name: "dt",
    version: getVersion(),
    description: "Self-healing CI/CD for GitHub Actions",
  },
  subCommands: {
    version: () => import("./version.js").then((m) => m.versionCommand),
    config: () => import("./config/index.js").then((m) => m.configCommand),
    auth: () => import("./auth/index.js").then((m) => m.authCommand),
    whoami: () => import("./whoami.js").then((m) => m.whoamiCommand),
    org: () => import("./org/index.js").then((m) => m.orgCommand),
    link: () => import("./link/index.js").then((m) => m.linkCommand),
    errors: () => import("./errors.js").then((m) => m.errorsCommand),
    update: () => import("./update.js").then((m) => m.updateCommand),
  },
});
