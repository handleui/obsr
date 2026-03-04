#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = "convex";
const OBSERVER_CONVEX_FILE = "apps/observer/src/db/convex.ts";

const EXPORT_FUNCTION_REGEX =
  /export\s+const\s+(\w+)\s*=\s*(?:query|mutation|internalQuery|internalMutation)\s*\(/g;
const SECURED_FUNCTIONS_SET_REGEX =
  /const\s+securedFunctions\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/;
const STRING_ENTRY_REGEX = /["']([^"']+)["']/g;

const containsRequireServiceAuth = (
  content: string,
  startIndex: number
): boolean => {
  let parenthesesDepth = 0;
  let sawOpenParenthesis = false;

  for (let index = startIndex; index < content.length; index++) {
    if (content[index] === "(") {
      parenthesesDepth += 1;
      sawOpenParenthesis = true;
      continue;
    }

    if (content[index] === ")") {
      parenthesesDepth -= 1;
      if (sawOpenParenthesis && parenthesesDepth === 0) {
        return content.slice(startIndex, index).includes("requireServiceAuth");
      }
    }
  }

  return false;
};

const extractSecuredFromConvexFile = (
  filePath: string,
  moduleName: string
): Set<string> => {
  const content = readFileSync(filePath, "utf-8");
  const securedFunctions = new Set<string>();

  EXPORT_FUNCTION_REGEX.lastIndex = 0;
  let functionMatch = EXPORT_FUNCTION_REGEX.exec(content);

  while (functionMatch !== null) {
    if (containsRequireServiceAuth(content, functionMatch.index)) {
      securedFunctions.add(`${moduleName}:${functionMatch[1]}`);
    }
    functionMatch = EXPORT_FUNCTION_REGEX.exec(content);
  }

  return securedFunctions;
};

const extractSecuredFromConvexSource = (): Set<string> => {
  const securedFunctions = new Set<string>();
  const convexFiles = readdirSync(CONVEX_DIR).filter(
    (fileName) => fileName.endsWith(".ts") && !fileName.startsWith("_")
  );

  for (const fileName of convexFiles) {
    const moduleName = fileName.replace(".ts", "");
    const moduleFunctions = extractSecuredFromConvexFile(
      join(CONVEX_DIR, fileName),
      moduleName
    );

    for (const functionName of moduleFunctions) {
      securedFunctions.add(functionName);
    }
  }

  return securedFunctions;
};

const extractSecuredFromObserverClient = (): Set<string> => {
  const content = readFileSync(OBSERVER_CONVEX_FILE, "utf-8");
  const securedFunctions = new Set<string>();
  const setMatch = SECURED_FUNCTIONS_SET_REGEX.exec(content);

  if (!setMatch) {
    throw new Error(
      `Unable to locate securedFunctions set in ${OBSERVER_CONVEX_FILE}`
    );
  }

  STRING_ENTRY_REGEX.lastIndex = 0;
  let entryMatch = STRING_ENTRY_REGEX.exec(setMatch[1]);

  while (entryMatch !== null) {
    securedFunctions.add(entryMatch[1]);
    entryMatch = STRING_ENTRY_REGEX.exec(setMatch[1]);
  }

  return securedFunctions;
};

const printMismatch = (title: string, entries: string[]): void => {
  console.error(title);
  for (const entry of entries) {
    const [moduleName, functionName] = entry.split(":");
    console.error(`  - ${moduleName}:${functionName}`);
  }
};

const verify = (): void => {
  const sourceSecured = extractSecuredFromConvexSource();
  const observerSecured = extractSecuredFromObserverClient();

  const missing = [...sourceSecured]
    .filter((entry) => !observerSecured.has(entry))
    .sort((left, right) => left.localeCompare(right));
  const extra = [...observerSecured]
    .filter((entry) => !sourceSecured.has(entry))
    .sort((left, right) => left.localeCompare(right));

  if (missing.length > 0 || extra.length > 0) {
    console.error("Secured function mismatch detected.");
    if (missing.length > 0) {
      printMismatch(
        `Missing from ${OBSERVER_CONVEX_FILE} securedFunctions (used requireServiceAuth in convex):`,
        missing
      );
    }
    if (extra.length > 0) {
      printMismatch(
        `Extra in ${OBSERVER_CONVEX_FILE} securedFunctions (no requireServiceAuth usage found):`,
        extra
      );
    }
    process.exit(1);
  }

  console.log(
    `securedFunctions is in sync: ${observerSecured.size} secured functions verified against convex sources`
  );
};

verify();
