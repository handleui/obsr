import { defineCommand } from "citty";

export const invitationsCommand = defineCommand({
  meta: {
    name: "invitations",
    description: "Manage organization invitations",
  },
  subCommands: {
    list: () => import("./list.js").then((m) => m.listCommand),
    revoke: () => import("./revoke.js").then((m) => m.revokeCommand),
  },
});
