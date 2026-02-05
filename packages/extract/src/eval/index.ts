import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CIError } from "@detent/types";
import { Eval } from "braintrust";
import { extractErrors } from "../extract.js";

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error("Error: AI_GATEWAY_API_KEY is required.");
  console.error("Set it via: export AI_GATEWAY_API_KEY='your-key'");
  process.exit(1);
}

const apiKey = process.env.AI_GATEWAY_API_KEY;

const FIXTURES_DIR = new URL("./fixtures", import.meta.url).pathname;
const EXPECTED_PATH = join(FIXTURES_DIR, "expected.json");

interface Fixture {
  name: string;
  content: string;
}

interface ExpectedErrors {
  [fixtureName: string]: CIError[];
}

const loadFixtures = (): Fixture[] => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));
  return files.map((file) => ({
    name: basename(file, ".txt"),
    content: readFileSync(join(FIXTURES_DIR, file), "utf-8"),
  }));
};

const loadExpected = (): ExpectedErrors | null => {
  if (!existsSync(EXPECTED_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(EXPECTED_PATH, "utf-8"));
  } catch {
    console.error(`Failed to parse expected.json at ${EXPECTED_PATH}`);
    console.error("Ensure the file contains valid JSON.");
    process.exit(1);
  }
};

/**
 * Completeness scorer: what % of expected errors were found?
 * Pre-computes lowercased messages grouped by filePath to avoid
 * O(n*m) repeated toLowerCase() allocations in the inner loop.
 */
const completenessScorer = (
  extracted: CIError[],
  expected: CIError[]
): { score: number; found: number; total: number; missed: string[] } => {
  if (expected.length === 0) {
    return { score: 1, found: 0, total: 0, missed: [] };
  }

  // Pre-compute lowercased messages once, grouped by filePath
  const extractedByPath = new Map<string, string[]>();
  for (const ext of extracted) {
    const key = ext.filePath ?? "";
    let bucket = extractedByPath.get(key);
    if (!bucket) {
      bucket = [];
      extractedByPath.set(key, bucket);
    }
    bucket.push(ext.message.toLowerCase());
  }
  const allExtractedMessages = extracted.map((e) => e.message.toLowerCase());

  const missed: string[] = [];
  let found = 0;

  for (const exp of expected) {
    const needle = exp.message.toLowerCase().slice(0, 120);
    const haystack = exp.filePath
      ? (extractedByPath.get(exp.filePath) ?? [])
      : allExtractedMessages;
    const match = haystack.some((msg) => msg.includes(needle));

    if (match) {
      found++;
    } else {
      missed.push(exp.message.slice(0, 100));
    }
  }

  return {
    score: found / expected.length,
    found,
    total: expected.length,
    missed,
  };
};

const printError = (i: number, error: CIError) => {
  console.log(
    `\n[${i + 1}] ${error.severity ?? "error"}: ${error.message.slice(0, 200)}`
  );
  if (error.filePath) {
    console.log(
      `    File: ${error.filePath}:${error.line ?? "?"}:${error.column ?? "?"}`
    );
  }
  if (error.ruleId) {
    console.log(`    Rule: ${error.ruleId}`);
  }
  if (error.source) {
    console.log(`    Source: ${error.source}`);
  }
  if (error.category) {
    console.log(`    Category: ${error.category}`);
  }
};

const printNextSteps = () => {
  console.log("\n\n=== NEXT STEPS ===");
  console.log("1. Review the errors above");
  console.log("2. Create expected.json with ground truth:");
  console.log(`   Path: ${EXPECTED_PATH}`);
  console.log(
    '   Format: { "fixture-name": [{ message: "...", filePath?: "..." }] }'
  );
  console.log("3. Run with --score to measure completeness");
};

const runBaseline = async () => {
  console.log("=== BASELINE MODE ===");
  console.log(
    "Extracting errors from fixtures. Review output to create expected.json.\n"
  );

  const fixtures = loadFixtures();

  for (const fixture of fixtures) {
    console.log(`\n--- ${fixture.name} ---`);
    console.log(`Content length: ${fixture.content.length} chars`);

    try {
      const result = await extractErrors(fixture.content, { apiKey });

      console.log(`Found ${result.errors.length} errors:`);
      console.log(`Detected source: ${result.detectedSource ?? "unknown"}`);
      console.log(`Truncated: ${result.truncated}`);
      if (result.costUsd) {
        console.log(`Cost: $${result.costUsd.toFixed(4)}`);
      }

      for (const [i, error] of result.errors.entries()) {
        printError(i, error);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`Error extracting from ${fixture.name}: ${message}`);
    }
  }

  printNextSteps();
};

const runEval = async () => {
  const fixtures = loadFixtures();
  const expected = loadExpected();

  if (!expected) {
    console.error("No expected.json found. Run in baseline mode first.");
    console.error("Usage: bun run eval (without --score)");
    process.exit(1);
  }

  console.log("=== SCORING MODE ===");
  console.log(`Fixtures: ${fixtures.length}`);
  console.log(`Expected definitions: ${Object.keys(expected).length}\n`);

  const sendLogs = !!process.env.BRAINTRUST_API_KEY;

  await Eval(
    "detent-extract",
    {
      data: () =>
        fixtures.map((f) => ({
          input: f.content,
          expected: expected[f.name] ?? [],
          metadata: { fixture: f.name },
        })),

      task: async (input: string) => {
        const result = await extractErrors(input, { apiKey });
        return result.errors;
      },

      scores: [
        (args: { input: string; output: CIError[]; expected: CIError[] }) => {
          const result = completenessScorer(args.output, args.expected);
          return {
            name: "completeness",
            score: result.score,
            metadata: {
              found: result.found,
              total: result.total,
              missed: result.missed,
            },
          };
        },
      ],
    },
    { noSendLogs: !sendLogs }
  );
};

const isScoreMode = process.argv.includes("--score");

await (isScoreMode ? runEval() : runBaseline());
