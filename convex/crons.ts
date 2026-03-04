import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "cleanup stale resolves",
  { minutes: 5 },
  internal.resolves.cleanupStaleHeals
);

export default crons;
