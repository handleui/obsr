import { existsSync, readFileSync, statSync } from "node:fs";

export interface DetectedOutput {
  tool: string;
  path: string;
  content: string;
}

const OUTPUT_PATTERNS: Record<string, string[]> = {
  eslint: ["eslint-report.json", "eslint.json"],
  vitest: ["vitest.json", "test-results.json"],
  golangci: [
    "golangci-lint.json",
    "golangci-lint-report.json",
    "lint-report.json",
    "report.json",
  ],
  typescript: ["tsc-output.txt", "typescript-errors.txt"],
};

/** Common output directories to check in addition to current directory */
const OUTPUT_DIRECTORIES = [
  ".",
  "./reports",
  "./test-results",
  "./coverage",
  "./.nyc_output",
];

/** Maximum file size to read (10MB) - prevents memory issues with huge files */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const tryReadFile = (path: string): string | null => {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const stats = statSync(path);
    if (stats.size > MAX_FILE_SIZE) {
      return null;
    }
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

const isNdjson = (content: string): boolean => {
  const lines = content.trim().split("\n");
  if (lines.length === 0) {
    return false;
  }
  // Check if each non-empty line is valid JSON
  return lines.every((line) => {
    if (!line.trim()) {
      return true;
    }
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
};

export const detectOutputs = (): DetectedOutput[] => {
  const outputs: DetectedOutput[] = [];

  // Check for JSON output files from CI tools in all common directories
  for (const [tool, patterns] of Object.entries(OUTPUT_PATTERNS)) {
    let found = false;
    for (const dir of OUTPUT_DIRECTORIES) {
      if (found) {
        break;
      }
      for (const pattern of patterns) {
        const filePath = dir === "." ? pattern : `${dir}/${pattern}`;
        const content = tryReadFile(filePath);
        if (content) {
          outputs.push({ tool, path: filePath, content });
          found = true;
          break; // Only use first found file per tool
        }
      }
    }
  }

  // Check for Cargo NDJSON output in captured stdout
  const cargoOutput = process.env.CARGO_STDOUT;
  if (cargoOutput && isNdjson(cargoOutput)) {
    outputs.push({
      tool: "cargo",
      path: "stdout",
      content: cargoOutput,
    });
  }

  return outputs;
};
