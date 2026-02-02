#!/usr/bin/env bun
/**
 * Verifies that securedQueries/securedMutations in convex-client.ts
 * stay in sync with Convex functions that call requireServiceAuth.
 *
 * Run: bun scripts/verify-secured-functions.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = "convex";
const CLIENT_FILE = "apps/navigator/src/lib/convex-client.ts";

// Top-level regex patterns
const EXPORT_FUNC_REGEX =
  /export\s+const\s+(\w+)\s*=\s*(?:query|mutation|internalQuery|internalMutation)\s*\(/g;
const SECURED_QUERIES_REGEX =
  /const\s+securedQueries\s*=\s*new\s+Set[^(]*\(\s*\[([\s\S]*?)\]\s*\)/;
const SECURED_MUTATIONS_REGEX =
  /const\s+securedMutations\s*=\s*new\s+Set[^(]*\(\s*\[([\s\S]*?)\]\s*\)/;
const API_ENTRY_REGEX = /api(?:\.(\w+)|\["([^"]+)"\])\.(\w+)/g;

// Check if a function body contains requireServiceAuth
const containsRequireServiceAuth = (
  content: string,
  startIdx: number
): boolean => {
  let braceCount = 0;
  let foundStart = false;

  for (let i = startIdx; i < content.length; i++) {
    if (content[i] === "(") {
      braceCount++;
      foundStart = true;
    } else if (content[i] === ")") {
      braceCount--;
      if (foundStart && braceCount === 0) {
        return content.slice(startIdx, i).includes("requireServiceAuth");
      }
    }
  }
  return false;
};

// Extract function names that call requireServiceAuth from a single file
const extractFromFile = (filePath: string, moduleName: string): Set<string> => {
  const funcs = new Set<string>();
  const content = readFileSync(filePath, "utf-8");

  // Reset regex state
  EXPORT_FUNC_REGEX.lastIndex = 0;

  let match = EXPORT_FUNC_REGEX.exec(content);
  while (match !== null) {
    if (containsRequireServiceAuth(content, match.index)) {
      funcs.add(`${moduleName}:${match[1]}`);
    }
    match = EXPORT_FUNC_REGEX.exec(content);
  }

  return funcs;
};

// Extract all secured functions from convex files
const extractSecuredFunctions = (): Set<string> => {
  const result = new Set<string>();
  const files = readdirSync(CONVEX_DIR).filter((f) => f.endsWith(".ts"));

  for (const file of files) {
    const moduleName = file.replace(".ts", "");
    const funcs = extractFromFile(join(CONVEX_DIR, file), moduleName);
    for (const f of funcs) {
      result.add(f);
    }
  }

  return result;
};

// Parse api entries from a Set block
const parseApiEntries = (block: string): Set<string> => {
  const entries = new Set<string>();
  API_ENTRY_REGEX.lastIndex = 0;

  let m = API_ENTRY_REGEX.exec(block);
  while (m !== null) {
    const module = m[1] || m[2];
    entries.add(`${module}:${m[3]}`);
    m = API_ENTRY_REGEX.exec(block);
  }

  return entries;
};

// Extract secured functions from convex-client.ts
const extractClientSecuredFunctions = (): Set<string> => {
  const content = readFileSync(CLIENT_FILE, "utf-8");
  const result = new Set<string>();

  const queriesMatch = SECURED_QUERIES_REGEX.exec(content);
  const mutationsMatch = SECURED_MUTATIONS_REGEX.exec(content);

  if (queriesMatch) {
    for (const entry of parseApiEntries(queriesMatch[1])) {
      result.add(entry);
    }
  }

  if (mutationsMatch) {
    for (const entry of parseApiEntries(mutationsMatch[1])) {
      result.add(entry);
    }
  }

  return result;
};

// Report missing functions
const reportMissing = (missing: string[]): void => {
  console.error(
    "Missing from convex-client.ts (add to securedQueries or securedMutations):"
  );
  for (const m of missing) {
    const [mod, func] = m.split(":");
    console.error(`  - api["${mod}"].${func}`);
  }
};

// Report extra functions
const reportExtra = (extra: string[]): void => {
  console.error(
    "\nExtra in convex-client.ts (no longer uses requireServiceAuth):"
  );
  for (const e of extra) {
    const [mod, func] = e.split(":");
    console.error(`  - api["${mod}"].${func}`);
  }
};

// Main verification
const verify = () => {
  const convexSecured = extractSecuredFunctions();
  const clientSecured = extractClientSecuredFunctions();

  const missing = [...convexSecured].filter((f) => !clientSecured.has(f));
  const extra = [...clientSecured].filter((f) => !convexSecured.has(f));

  if (missing.length > 0 || extra.length > 0) {
    console.error("❌ Secured functions mismatch!\n");
    if (missing.length > 0) {
      reportMissing(missing);
    }
    if (extra.length > 0) {
      reportExtra(extra);
    }
    console.error("\nSee: apps/navigator/src/lib/convex-client.ts");
    process.exit(1);
  }

  console.log("✓ Secured functions are in sync");
  console.log(`  ${clientSecured.size} functions verified`);
};

verify();
