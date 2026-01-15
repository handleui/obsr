import { defineCommand } from "citty";

export const orgCommand = defineCommand({
  meta: {
    name: "org",
    description: "Manage organizations",
  },
  subCommands: {
    link: () => import("./link.js").then((m) => m.linkCommand),
    list: () => import("./list.js").then((m) => m.listCommand),
    members: () => import("./members.js").then((m) => m.membersCommand),
    leave: () => import("./leave.js").then((m) => m.leaveCommand),
  },
});
