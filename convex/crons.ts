import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "cleanup stale heals",
  { minutes: 5 },
  internal.heals.cleanupStaleHeals
);

export default crons;
