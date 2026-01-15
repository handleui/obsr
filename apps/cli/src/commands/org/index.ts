import { defineCommand } from "citty";

export const orgCommand = defineCommand({
  meta: {
    name: "org",
    description: "Manage organizations",
  },
  subCommands: {
    add: () => import("./add.js").then((m) => m.addCommand),
    list: () => import("./list.js").then((m) => m.listCommand),
    leave: () => import("./leave.js").then((m) => m.leaveCommand),
  },
});
