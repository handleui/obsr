import type { Category } from "./error-line";

export interface SourceLine {
  lineNumber: number;
  content: string;
}

export interface ErrorDetailData {
  id: string;
  category: Category;
  location: string;
  message: string;
  origin: string;
  errorType: string;
  status: string;
  diff?: string;
  filename?: string;
  collapsedBefore?: number;
  collapsedAfter?: number;
  sourceLines?: SourceLine[];
  faultyLineNumbers?: number[];
}

export interface JobMeta {
  key: string;
  status: string;
}

export interface MockRun {
  org: string;
  project: string;
  run: string;
  title: string;
  author: string;
  branch: { source: string; target: string };
  files: number;
  additions: number;
  deletions: number;
  description: string;
  jobs: JobMeta[];
  errors: ErrorDetailData[];
}

// ---------------------------------------------------------------------------
// handleui/detent diffs (existing)
// ---------------------------------------------------------------------------

const SCRUB_SECRETS_DIFF = `diff --git a/apps/api/src/lib/scrub-secrets.ts b/apps/api/src/lib/scrub-secrets.ts
index 4a3e2f1..b7c9d4a 100644
--- a/apps/api/src/lib/scrub-secrets.ts
+++ b/apps/api/src/lib/scrub-secrets.ts
@@ -1,7 +1,9 @@
-import { createHash } from "node:crypto";
+import { createHash, randomUUID } from "node:crypto";
+import type { SecretPattern } from "@detent/parser";
${" "}
 const SECRET_PATTERNS = [
 \t/ghp_[a-zA-Z0-9]{36}/g,
 \t/npm_[a-zA-Z0-9]{36}/g,
+\t/sk-[a-zA-Z0-9]{48}/g,
 ];
@@ -17,7 +19,7 @@ const hashToken = (token: string): string => {
${" "}
-export const scrubSecrets = (input: string): string => {
+export const scrubSecrets = (input: string, patterns?: SecretPattern[]): string => {
 \tlet result = input;
-\tfor (const pattern of SECRET_PATTERNS) {
+\tfor (const pattern of [...SECRET_PATTERNS, ...(patterns ?? [])]) {
 \t\tresult = result.replace(pattern, (match) => {
 \t\t\treturn \`\${REDACTED_PREFIX}\${hashToken(match)}]\`;
 \t\t});
`;

const WEBHOOK_DIFF = `diff --git a/apps/api/src/routes/webhooks.ts b/apps/api/src/routes/webhooks.ts
index 8f2a1b3..c4d5e6f 100644
--- a/apps/api/src/routes/webhooks.ts
+++ b/apps/api/src/routes/webhooks.ts
@@ -1,5 +1,5 @@
 import { Hono } from "hono";
-import { createWebhookHandler } from "../lib/webhooks";
+import { registerWebhook } from "../lib/webhooks";
 import { authMiddleware } from "../middleware/auth";
 import { rateLimiter } from "../middleware/rate-limit";
 import { validateSignature } from "../lib/crypto";
@@ -14,7 +14,7 @@ app.get("/hooks/health", (c) => c.json({ ok: true }));
${" "}
 app.post("/hooks/:provider", validateSignature(),
-\tcreateWebhookHandler());
+\tregisterWebhook());
${" "}
 app.get("/hooks/:provider/events", async (c) => {
 \tconst events = await c.var.db.query("webhook_events").collect();
 \treturn c.json(events);
`;

const MIGRATION_DIFF = `diff --git a/convex/migrations/002_add_indexes.ts b/convex/migrations/002_add_indexes.ts
index 1a2b3c4..d5e6f7a 100644
--- a/convex/migrations/002_add_indexes.ts
+++ b/convex/migrations/002_add_indexes.ts
@@ -3,9 +3,11 @@
 import { migration } from "../lib/migrate";
${" "}
 export default migration({
 \ttable: "heals",
 \tmigrateOne: async (ctx, doc) => {
-\t\tif (!doc.run_id) return;
+\t\tif (!doc.run_id) {
+\t\t\tthrow new Error("run_id is required — cannot add NOT NULL constraint");
+\t\t}
 \t\tawait ctx.db.patch(doc._id, { run_id: doc.run_id });
 \t},
 });
`;

const ERROR_HANDLING_DIFF = `diff --git a/packages/parser/src/errors.ts b/packages/parser/src/errors.ts
index 2f1a3b4..8c9d0e1 100644
--- a/packages/parser/src/errors.ts
+++ b/packages/parser/src/errors.ts
@@ -1,12 +1,22 @@
-export class ParseError extends Error {
-\tconstructor(message: string) {
-\t\tsuper(message);
-\t\tthis.name = "ParseError";
+export interface ErrorContext {
+\tfilePath: string;
+\tlineNumber: number;
+\tcolumn?: number;
+\tsource?: string;
+}
+
+export class ParseError extends Error {
+\treadonly context: ErrorContext;
+
+\tconstructor(message: string, context: ErrorContext) {
+\t\tsuper(\`\${context.filePath}:\${context.lineNumber}: \${message}\`);
+\t\tthis.name = "ParseError";
+\t\tthis.context = context;
 \t}
 }
${" "}
-export class ExtractionError extends Error {
-\tconstructor(message: string) {
-\t\tsuper(message);
-\t\tthis.name = "ExtractionError";
+export class ExtractionError extends ParseError {
+\tconstructor(message: string, context: ErrorContext) {
+\t\tsuper(message, context);
+\t\tthis.name = "ExtractionError";
 \t}
 }
diff --git a/packages/parser/src/extract.ts b/packages/parser/src/extract.ts
index 5e6f7a8..1b2c3d4 100644
--- a/packages/parser/src/extract.ts
+++ b/packages/parser/src/extract.ts
@@ -1,5 +1,5 @@
 import { tokenize } from "./tokenizer";
-import { ExtractionError } from "./errors";
+import { ExtractionError, type ErrorContext } from "./errors";
 import type { LogLine, ExtractedError } from "./types";
${" "}
 const PATTERNS = [
@@ -18,7 +18,11 @@ export const extractErrors = (lines: LogLine[]): ExtractedError[] => {
 \t\t\tconst match = line.content.match(pattern.regex);
 \t\t\tif (!match) continue;
${" "}
-\t\t\tif (!match.groups?.message) throw new ExtractionError("Missing capture group 'message'");
+\t\t\tif (!match.groups?.message) {
+\t\t\t\tconst ctx: ErrorContext = { filePath: line.file ?? "<stdin>", lineNumber: line.number };
+\t\t\t\tthrow new ExtractionError("Missing capture group 'message'", ctx);
+\t\t\t}
${" "}
 \t\t\tresults.push({
 \t\t\t\ttype: pattern.type,
@@ -34,7 +38,8 @@ export const extractErrors = (lines: LogLine[]): ExtractedError[] => {
 \treturn results;
 };
${" "}
-export const extractErrorsFromString = (raw: string): ExtractedError[] => {
+export const extractErrorsFromString = (raw: string, filePath = "<raw>"): ExtractedError[] => {
 \tconst lines: LogLine[] = raw.split("\\n").map((content, i) => ({
+\t\tfile: filePath,
 \t\tnumber: i + 1,
 \t\tcontent,
diff --git a/apps/api/src/services/webhooks/error-extraction.ts b/apps/api/src/services/webhooks/error-extraction.ts
index 7a8b9c0..d1e2f3a 100644
--- a/apps/api/src/services/webhooks/error-extraction.ts
+++ b/apps/api/src/services/webhooks/error-extraction.ts
@@ -1,6 +1,6 @@
 import { extractErrorsFromString } from "@detent/parser";
-import { ExtractionError } from "@detent/parser/errors";
-import type { WebhookPayload } from "../types";
+import { ExtractionError, type ErrorContext } from "@detent/parser/errors";
+import type { WebhookPayload, RunContext } from "../types";
${" "}
 export const processWebhookLog = async (payload: WebhookPayload) => {
 \tconst { log, runId, provider } = payload;
@@ -8,11 +8,16 @@ export const processWebhookLog = async (payload: WebhookPayload) => {
 \ttry {
-\t\tconst errors = extractErrorsFromString(log);
+\t\tconst errors = extractErrorsFromString(log, \`\${provider}/\${runId}\`);
 \t\treturn { errors, status: "ok" as const };
 \t} catch (err) {
 \t\tif (err instanceof ExtractionError) {
-\t\t\tconsole.error("[extraction]", err.message);
-\t\t\treturn { errors: [], status: "extraction_failed" as const };
+\t\t\tconst ctx: ErrorContext = err.context;
+\t\t\tconsole.error(
+\t\t\t\t"[extraction]",
+\t\t\t\t\`\${ctx.filePath}:\${ctx.lineNumber}\`,
+\t\t\t\terr.message,
+\t\t\t);
+\t\t\treturn { errors: [], status: "extraction_failed" as const, context: ctx };
 \t\t}
 \t\tthrow err;
 \t}
`;

// ---------------------------------------------------------------------------
// handleui/navigator diffs
// ---------------------------------------------------------------------------

const NEXTJS_BUILD_DIFF = `diff --git a/apps/navigator/src/app/dashboard/page.tsx b/apps/navigator/src/app/dashboard/page.tsx
index 5f6a7b8..c9d0e1f 100644
--- a/apps/navigator/src/app/dashboard/page.tsx
+++ b/apps/navigator/src/app/dashboard/page.tsx
@@ -1,8 +1,12 @@
-import dynamic from "next/dynamic";
+import { Suspense } from "react";
+import { DashboardSkeleton } from "./_components/skeleton";
${" "}
-const Dashboard = dynamic(() => import("./_components/dashboard"), {
-\tssr: false,
-});
+export const generateStaticParams = async () => {
+\treturn [];
+};
+
+import { Dashboard } from "./_components/dashboard";
${" "}
-export default Dashboard;
+const DashboardPage = () => (
+\t<Suspense fallback={<DashboardSkeleton />}>
+\t\t<Dashboard />
+\t</Suspense>
+);
+
+export default DashboardPage;
`;

// ---------------------------------------------------------------------------
// detentsh/detent diffs
// ---------------------------------------------------------------------------

const HEAL_PROGRESS_DIFF = `diff --git a/packages/healing/src/progress.ts b/packages/healing/src/progress.ts
index a1b2c3d..e4f5a6b 100644
--- a/packages/healing/src/progress.ts
+++ b/packages/healing/src/progress.ts
@@ -8,10 +8,14 @@ export interface HealProgress {
 \tstatus: "pending" | "running" | "complete" | "failed";
 \tsteps: HealStep[];
+\tstartedAt: number;
+\tcompletedAt?: number;
 }
${" "}
-export const createProgress = (): HealProgress => ({
+export const createProgress = (steps: string[]): HealProgress => ({
 \tstatus: "pending",
-\tsteps: [],
+\tsteps: steps.map((name) => ({ name, status: "pending" as const })),
+\tstartedAt: Date.now(),
 });
`;

const TYPESCRIPT_STRICT_DIFF = `diff --git a/packages/healing/src/stream.ts b/packages/healing/src/stream.ts
index 7c8d9e0..1f2a3b4 100644
--- a/packages/healing/src/stream.ts
+++ b/packages/healing/src/stream.ts
@@ -12,8 +12,10 @@ interface StreamOptions {
${" "}
 export const createHealStream = (options: StreamOptions) => {
-\tconst controller = new AbortController();
-\tconst signal = options.signal ?? controller.signal;
+\tconst controller: AbortController | null = options.signal
+\t\t? null
+\t\t: new AbortController();
+\tconst signal = options.signal ?? controller!.signal;
${" "}
 \treturn {
-\t\tabort: () => controller.abort(),
+\t\tabort: () => controller?.abort(),
 \t\tstream: streamHealing(options.input, { signal }),
 \t};
 };
`;

// ---------------------------------------------------------------------------
// handleui/detent errors (existing)
// ---------------------------------------------------------------------------

const DETENT_ERRORS: ErrorDetailData[] = [
  {
    id: "test-0",
    category: "Error",
    location: "packages/healing/src/autofix.ts",
    message:
      "Cannot find module '@detent/autofix' or its corresponding type declarations",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Typescript",
    status: "Found",
    filename: "autofix.ts",
    sourceLines: [
      { lineNumber: 1, content: 'import { createHash } from "node:crypto";' },
      {
        lineNumber: 2,
        content: 'import type { AutofixResult } from "@detent/autofix";',
      },
      { lineNumber: 3, content: "" },
      {
        lineNumber: 4,
        content:
          "export const runAutofix = async (input: string): Promise<AutofixResult> => {",
      },
      {
        lineNumber: 5,
        content:
          '\tconst hash = createHash("sha256").update(input).digest("hex");',
      },
      { lineNumber: 6, content: "\treturn { hash, fixed: false };" },
      { lineNumber: 7, content: "};" },
    ],
    faultyLineNumbers: [2],
  },
  {
    id: "test-1",
    category: "Info",
    location: "apps/api/src/routes/webhooks.ts",
    message:
      "'createWebhookHandler' is deprecated — use 'registerWebhook' instead",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Typescript",
    status: "Fixed",
    diff: WEBHOOK_DIFF,
    filename: "webhooks.ts",
  },
  {
    id: "test-3",
    category: "Error",
    location: "apps/api/src/lib/scrub-secrets.ts",
    message:
      "Argument of type 'string' is not assignable to parameter of type 'SecretPattern'",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Typescript",
    status: "Fixed",
    diff: SCRUB_SECRETS_DIFF,
    filename: "scrub-secrets.ts",
  },
  {
    id: "test-4",
    category: "Error",
    location: "packages/parser/src/errors.ts (+2 files)",
    message:
      "ParseError constructor expects 'ErrorContext' — 3 call sites need updating after signature change",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Typescript",
    status: "Fixed",
    diff: ERROR_HANDLING_DIFF,
    filename: "errors.ts",
  },
  {
    id: "test-2",
    category: "Info",
    location: "packages/parser/src/__tests__/extract.test.ts",
    message: "Expected 12 assertions but found 9 — test may be incomplete",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Vitest",
    status: "Found",
    filename: "extract.test.ts",
    sourceLines: [
      { lineNumber: 14, content: 'describe("extract", () => {' },
      {
        lineNumber: 15,
        content: '\tit("should extract all error patterns", () => {',
      },
      {
        lineNumber: 16,
        content: "\t\tconst result = extractErrors(sampleLog);",
      },
      { lineNumber: 17, content: "\t\texpect(result).toHaveLength(12);" },
      {
        lineNumber: 18,
        content: '\t\texpect(result[0].type).toBe("typescript");',
      },
      {
        lineNumber: 19,
        content:
          '\t\texpect(result[0].message).toContain("Cannot find module");',
      },
    ],
    faultyLineNumbers: [17],
  },
  {
    id: "mig-0",
    category: "Error",
    location: "convex/schema.ts",
    message: "Column 'webhook_url' already exists on table 'organizations'",
    origin: "CI / Migrations (ubuntu-latest)",
    errorType: "Database",
    status: "Healing",
    filename: "schema.ts",
    sourceLines: [
      { lineNumber: 12, content: "" },
      { lineNumber: 13, content: "\torganizations: defineTable({" },
      { lineNumber: 14, content: "\t\tname: v.string()," },
      { lineNumber: 15, content: "\t\tslug: v.string()," },
      { lineNumber: 16, content: "\t\twebhook_url: v.optional(v.string())," },
      {
        lineNumber: 17,
        content: "\t\twebhook_secret: v.optional(v.string()),",
      },
      { lineNumber: 18, content: '\t}).index("by_slug", ["slug"]),' },
    ],
    faultyLineNumbers: [16, 17],
  },
  {
    id: "mig-1",
    category: "Warning",
    location: "convex/migrations/002_add_indexes.ts",
    message:
      "Adding NOT NULL constraint may fail — existing rows have NULL values",
    origin: "CI / Migrations (ubuntu-latest)",
    errorType: "Database",
    status: "Healing",
    diff: MIGRATION_DIFF,
    filename: "002_add_indexes.ts",
  },
  {
    id: "mig-2",
    category: "Warning",
    location: "convex/migrations/003_relations.ts",
    message:
      "Foreign key on 'heals.run_id' references 'runs.id' — 4 orphaned rows found",
    origin: "CI / Migrations (ubuntu-latest)",
    errorType: "Database",
    status: "Healing",
    filename: "003_relations.ts",
    sourceLines: [
      { lineNumber: 5, content: "export default migration({" },
      { lineNumber: 6, content: '\ttable: "heals",' },
      { lineNumber: 7, content: "\tmigrateOne: async (ctx, doc) => {" },
      {
        lineNumber: 8,
        content: "\t\tconst run = await ctx.db.get(doc.run_id);",
      },
      { lineNumber: 9, content: "\t\tif (!run) return;" },
      {
        lineNumber: 10,
        content: "\t\tawait ctx.db.patch(doc._id, { verified: true });",
      },
      { lineNumber: 11, content: "\t}," },
      { lineNumber: 12, content: "});" },
    ],
    faultyLineNumbers: [8, 9],
  },
  {
    id: "mig-3",
    category: "Warning",
    location: "convex/migrations/004_perf.ts",
    message:
      "Index creation on 'logs' (2.4M rows) may lock table during migration",
    origin: "CI / Migrations (ubuntu-latest)",
    errorType: "Database",
    status: "Healing",
    filename: "004_perf.ts",
    sourceLines: [
      { lineNumber: 3, content: "export default migration({" },
      { lineNumber: 4, content: '\ttable: "logs",' },
      { lineNumber: 5, content: "\tmigrateOne: async (ctx, doc) => {" },
      { lineNumber: 6, content: "\t\tawait ctx.db.patch(doc._id, {" },
      { lineNumber: 7, content: "\t\t\tindexed_at: Date.now()," },
      { lineNumber: 8, content: "\t\t});" },
      { lineNumber: 9, content: "\t}," },
      { lineNumber: 10, content: "});" },
    ],
    faultyLineNumbers: [6, 7],
  },
  {
    id: "mig-4",
    category: "Info",
    location: "convex/migrations/005_cleanup.ts",
    message: "Dry-run passed — 340 rows affected by 'archived_at' backfill",
    origin: "CI / Migrations (ubuntu-latest)",
    errorType: "Database",
    status: "Healing",
    filename: "005_cleanup.ts",
    sourceLines: [
      { lineNumber: 5, content: "export default migration({" },
      { lineNumber: 6, content: '\ttable: "runs",' },
      { lineNumber: 7, content: "\tmigrateOne: async (ctx, doc) => {" },
      { lineNumber: 8, content: "\t\tif (!doc.archived_at) {" },
      {
        lineNumber: 9,
        content:
          "\t\t\tawait ctx.db.patch(doc._id, { archived_at: Date.now() });",
      },
      { lineNumber: 10, content: "\t\t}" },
      { lineNumber: 11, content: "\t}," },
      { lineNumber: 12, content: "});" },
    ],
    faultyLineNumbers: [9],
  },
];

// ---------------------------------------------------------------------------
// handleui/navigator errors
// ---------------------------------------------------------------------------

const NAVIGATOR_ERRORS: ErrorDetailData[] = [
  {
    id: "lint-0",
    category: "Error",
    location: "apps/navigator/src/lib/session.ts",
    message:
      "'jose' is imported but 'SignJWT' is never used. (no-unused-imports)",
    origin: "CI / Lint (ubuntu-latest)",
    errorType: "Biome",
    status: "Found",
    filename: "session.ts",
    sourceLines: [
      {
        lineNumber: 1,
        content: 'import { jwtVerify, SignJWT } from "jose";',
      },
      {
        lineNumber: 2,
        content:
          'import type { SessionPayload, RefreshResult } from "./types";',
      },
      { lineNumber: 3, content: "" },
      {
        lineNumber: 4,
        content:
          "export const refreshSession = async (token: string): Promise<RefreshResult> => {",
      },
      {
        lineNumber: 5,
        content: "\tconst { payload } = await jwtVerify(token, SECRET);",
      },
      { lineNumber: 6, content: "\treturn { payload };" },
      { lineNumber: 7, content: "};" },
    ],
    faultyLineNumbers: [1],
  },
  {
    id: "lint-1",
    category: "Warning",
    location: "apps/navigator/src/middleware.ts",
    message:
      "Unexpected 'any'. Specify a different type. (lint/suspicious/noExplicitAny)",
    origin: "CI / Lint (ubuntu-latest)",
    errorType: "Biome",
    status: "Found",
    filename: "middleware.ts",
    sourceLines: [
      {
        lineNumber: 8,
        content: 'import { NextResponse } from "next/server";',
      },
      { lineNumber: 9, content: "" },
      {
        lineNumber: 10,
        content: "const decodeToken = (raw: string): any => {",
      },
      {
        lineNumber: 11,
        content: '\treturn JSON.parse(atob(raw.split(".")[1]));',
      },
      { lineNumber: 12, content: "};" },
    ],
    faultyLineNumbers: [10],
  },
  {
    id: "lint-2",
    category: "Info",
    location: "apps/navigator/src/hooks/use-auth.ts",
    message:
      "'let' is never reassigned. Use 'const' instead. (lint/style/useConst)",
    origin: "CI / Lint (ubuntu-latest)",
    errorType: "Biome",
    status: "Found",
    filename: "use-auth.ts",
    sourceLines: [
      { lineNumber: 22, content: "const useAuth = () => {" },
      {
        lineNumber: 23,
        content: "\tlet session = useSession();",
      },
      {
        lineNumber: 24,
        content: "\tconst router = useRouter();",
      },
      { lineNumber: 25, content: "" },
      {
        lineNumber: 26,
        content: "\tconst logout = useCallback(() => {",
      },
    ],
    faultyLineNumbers: [23],
  },
  {
    id: "build-0",
    category: "Error",
    location: "apps/navigator/src/app/dashboard/page.tsx",
    message:
      "Page \"/dashboard\" is using 'dynamic' from 'next/dynamic' with ssr:false — this is not supported with App Router",
    origin: "CI / Build (ubuntu-latest)",
    errorType: "Next.js",
    status: "Fixed",
    diff: NEXTJS_BUILD_DIFF,
    filename: "page.tsx",
  },
  {
    id: "build-1",
    category: "Error",
    location: "apps/navigator/src/app/settings/[tab]/page.tsx",
    message:
      'Page "/settings/[tab]" is missing generateStaticParams() — required for static export with dynamic routes',
    origin: "CI / Build (ubuntu-latest)",
    errorType: "Next.js",
    status: "Found",
    filename: "page.tsx",
    sourceLines: [
      {
        lineNumber: 1,
        content: 'import { SettingsPanel } from "./_components/panel";',
      },
      { lineNumber: 2, content: "" },
      {
        lineNumber: 3,
        content: "interface SettingsPageProps {",
      },
      {
        lineNumber: 4,
        content: "\tparams: Promise<{ tab: string }>;",
      },
      { lineNumber: 5, content: "}" },
      { lineNumber: 6, content: "" },
      {
        lineNumber: 7,
        content:
          "const SettingsPage = async ({ params }: SettingsPageProps) => {",
      },
      {
        lineNumber: 8,
        content: "\tconst { tab } = await params;",
      },
      {
        lineNumber: 9,
        content: "\treturn <SettingsPanel tab={tab} />;",
      },
      { lineNumber: 10, content: "};" },
    ],
    faultyLineNumbers: [7],
  },
];

// ---------------------------------------------------------------------------
// detentsh/detent errors
// ---------------------------------------------------------------------------

const HEALER_ERRORS: ErrorDetailData[] = [
  {
    id: "test-0",
    category: "Error",
    location: "packages/healing/src/__tests__/progress.test.ts",
    message:
      'AssertionError: expected "running" to be "complete" — heal progress did not resolve within 5000ms',
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Vitest",
    status: "Found",
    filename: "progress.test.ts",
    sourceLines: [
      {
        lineNumber: 18,
        content: 'it("should mark progress as complete", async () => {',
      },
      {
        lineNumber: 19,
        content:
          '\tconst progress = createProgress(["parse", "fix", "verify"]);',
      },
      {
        lineNumber: 20,
        content: "\tawait runHeal(progress);",
      },
      {
        lineNumber: 21,
        content: '\texpect(progress.status).toBe("complete");',
      },
      {
        lineNumber: 22,
        content: "\texpect(progress.completedAt).toBeDefined();",
      },
      { lineNumber: 23, content: "});" },
    ],
    faultyLineNumbers: [21],
  },
  {
    id: "test-1",
    category: "Error",
    location: "packages/healing/src/__tests__/stream.test.ts",
    message:
      "AssertionError: expected [] to have length 3 — stream chunks were empty",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Vitest",
    status: "Found",
    filename: "stream.test.ts",
    sourceLines: [
      {
        lineNumber: 31,
        content: 'it("should emit heal chunks as they arrive", async () => {',
      },
      {
        lineNumber: 32,
        content: "\tconst chunks: HealChunk[] = [];",
      },
      {
        lineNumber: 33,
        content: "\tconst stream = createHealStream({ input: sampleInput });",
      },
      {
        lineNumber: 34,
        content: "\tfor await (const chunk of stream.stream) {",
      },
      {
        lineNumber: 35,
        content: "\t\tchunks.push(chunk);",
      },
      { lineNumber: 36, content: "\t}" },
      {
        lineNumber: 37,
        content: "\texpect(chunks).toHaveLength(3);",
      },
      { lineNumber: 38, content: "});" },
    ],
    faultyLineNumbers: [37],
  },
  {
    id: "test-2",
    category: "Warning",
    location: "packages/healing/src/__tests__/timeout.test.ts",
    message:
      "Test timed out in 10000ms — heal operation exceeded maximum allowed duration",
    origin: "CI / Test (ubuntu-latest)",
    errorType: "Vitest",
    status: "Found",
    filename: "timeout.test.ts",
    sourceLines: [
      {
        lineNumber: 8,
        content: 'it("should abort heal after timeout", async () => {',
      },
      {
        lineNumber: 9,
        content: "\tconst controller = new AbortController();",
      },
      {
        lineNumber: 10,
        content:
          "\tconst result = await heal(largeInput, { signal: controller.signal, timeout: 5000 });",
      },
      {
        lineNumber: 11,
        content: '\texpect(result.status).toBe("aborted");',
      },
      {
        lineNumber: 12,
        content: "}, 10000);",
      },
    ],
    faultyLineNumbers: [10],
  },
  {
    id: "types-0",
    category: "Error",
    location: "packages/healing/src/progress.ts",
    message:
      "Property 'startedAt' does not exist on type 'HealProgress' — type was updated but implementation lags behind",
    origin: "CI / Check Types (ubuntu-latest)",
    errorType: "Typescript",
    status: "Fixed",
    diff: HEAL_PROGRESS_DIFF,
    filename: "progress.ts",
  },
  {
    id: "types-1",
    category: "Error",
    location: "packages/healing/src/stream.ts",
    message:
      "Object is possibly 'null' — 'controller' may be null when 'options.signal' is provided (TS18047)",
    origin: "CI / Check Types (ubuntu-latest)",
    errorType: "Typescript",
    status: "Fixed",
    diff: TYPESCRIPT_STRICT_DIFF,
    filename: "stream.ts",
  },
];

// ---------------------------------------------------------------------------
// MOCK_RUNS registry
// ---------------------------------------------------------------------------

const DETENT_JOBS: JobMeta[] = [
  { key: "lint", status: "waiting" },
  { key: "test", status: "failed" },
  { key: "check-types", status: "successful" },
  { key: "migrations", status: "healing" },
  { key: "build", status: "skipped" },
];

const NAVIGATOR_JOBS: JobMeta[] = [
  { key: "lint", status: "failed" },
  { key: "build", status: "failed" },
  { key: "check-types", status: "successful" },
  { key: "test", status: "successful" },
];

const HEALER_JOBS: JobMeta[] = [
  { key: "test", status: "failed" },
  { key: "check-types", status: "failed" },
  { key: "lint", status: "successful" },
  { key: "build", status: "skipped" },
];

const MOCK_RUNS = new Map<string, MockRun>([
  [
    "handleui/detent",
    {
      org: "handleui",
      project: "detent",
      run: "159",
      title: "feat(sdk): add SDK and MCP server packages",
      author: "Rodrigo Jimenez",
      branch: { source: "handleui/sdk-mcp", target: "main" },
      files: 8,
      additions: 440,
      deletions: 1130,
      description: "Add SDK and MCP server packages for external integrations.",
      jobs: DETENT_JOBS,
      errors: DETENT_ERRORS,
    },
  ],
  [
    "handleui/navigator",
    {
      org: "handleui",
      project: "navigator",
      run: "42",
      title: "fix(auth): update session token refresh",
      author: "Rodrigo Jimenez",
      branch: { source: "fix/session-refresh", target: "main" },
      files: 5,
      additions: 87,
      deletions: 34,
      description:
        "Fix session token refresh to use shorter expiration and validate subject claim before signing.",
      jobs: NAVIGATOR_JOBS,
      errors: NAVIGATOR_ERRORS,
    },
  ],
  [
    "detentsh/detent",
    {
      org: "detentsh",
      project: "detent",
      run: "87",
      title: "feat(healer): streaming heal progress",
      author: "Rodrigo Jimenez",
      branch: { source: "feat/heal-stream", target: "main" },
      files: 12,
      additions: 310,
      deletions: 95,
      description:
        "Add streaming support for heal progress so users see real-time updates during AI healing.",
      jobs: HEALER_JOBS,
      errors: HEALER_ERRORS,
    },
  ],
]);

export const getMockRun = (org: string, project: string): MockRun | null =>
  MOCK_RUNS.get(`${org}/${project}`) ?? null;

export const getDefaultRun = (org: string, project: string): string | null => {
  const run = MOCK_RUNS.get(`${org}/${project}`);
  return run?.run ?? null;
};

export const getAllOrgs = (): string[] => {
  const orgs = new Set<string>();
  for (const run of MOCK_RUNS.values()) {
    orgs.add(run.org);
  }
  return [...orgs];
};

export const getProjectsForOrg = (org: string): string[] => {
  const projects = new Set<string>();
  for (const run of MOCK_RUNS.values()) {
    if (run.org === org) {
      projects.add(run.project);
    }
  }
  return [...projects];
};

export const errorIdToJobKey = (id: string): string => {
  const prefix = id.split("-")[0];
  if (prefix === "mig") {
    return "migrations";
  }
  return prefix;
};
