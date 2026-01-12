import { desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { runErrors, runs } from "../src/db/schema";

const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/detent";
const client = new Client({ connectionString });
await client.connect();
const db = drizzle({ client });

const main = async () => {
  console.log("\n=== RUNS ===");
  const allRuns = await db
    .select({
      id: runs.id,
      repository: runs.repository,
      commitSha: runs.commitSha,
      prNumber: runs.prNumber,
      runId: runs.runId,
      errorCount: runs.errorCount,
      receivedAt: runs.receivedAt,
    })
    .from(runs)
    .orderBy(desc(runs.receivedAt))
    .limit(20);

  console.table(
    allRuns.map((r) => ({
      ...r,
      commitSha: r.commitSha?.slice(0, 7),
      id: `${r.id.slice(0, 8)}...`,
    }))
  );

  console.log("\n=== ERRORS ===");
  const allErrors = await db
    .select({
      runId: runErrors.runId,
      filePath: runErrors.filePath,
      line: runErrors.line,
      message: runErrors.message,
      category: runErrors.category,
      source: runErrors.source,
      workflowJob: runErrors.workflowJob,
      unknownPattern: runErrors.unknownPattern,
      possiblyTestOutput: runErrors.possiblyTestOutput,
    })
    .from(runErrors)
    .limit(30);

  console.table(
    allErrors.map((e) => ({
      runId: `${e.runId.slice(0, 8)}...`,
      filePath: e.filePath,
      line: e.line,
      category: e.category,
      source: e.source,
      testOutput: e.possiblyTestOutput,
      unknownPat: e.unknownPattern,
      message: `${e.message?.slice(0, 50)}${e.message && e.message.length > 50 ? "..." : ""}`,
    }))
  );

  console.log("\nFull error messages:");
  for (const e of allErrors) {
    console.log(`- ${e.message}`);
  }

  console.log("\n=== SUMMARY ===");
  const summary = await db
    .select({
      totalRuns: sql<number>`count(*)`,
      totalErrors: sql<number>`sum(${runs.errorCount})`,
      uniquePRs: sql<number>`count(distinct ${runs.prNumber})`,
      uniqueCommits: sql<number>`count(distinct ${runs.commitSha})`,
    })
    .from(runs);

  console.log("Total runs:", summary[0]?.totalRuns);
  console.log("Total errors:", summary[0]?.totalErrors);
  console.log("Unique PRs:", summary[0]?.uniquePRs);
  console.log("Unique commits:", summary[0]?.uniqueCommits);

  await client.end();
};

main().catch(console.error);
