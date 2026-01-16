import type { HintRule } from "../types.js";

export const HINT_RULES: HintRule[] = [
  // TypeScript - Type Errors (TS2xxx)
  {
    source: "typescript",
    ruleId: "TS2322",
    hint: "Type mismatch. Check type assertion, generic parameter, or use compatible type.",
    docUrl: "https://typescript.tv/errors/#ts2322",
  },
  {
    source: "typescript",
    ruleId: "TS2339",
    hint: "Property doesn't exist on type. Check spelling, add to interface, or use optional chaining.",
    docUrl: "https://typescript.tv/errors/#ts2339",
  },
  {
    source: "typescript",
    ruleId: "TS2345",
    hint: "Argument type mismatch. Check function signature or convert argument type.",
    docUrl: "https://typescript.tv/errors/#ts2345",
  },
  {
    source: "typescript",
    ruleId: "TS2532",
    hint: "Object possibly undefined. Add null check, optional chaining (?.), or non-null assertion (!).",
    docUrl: "https://typescript.tv/errors/#ts2532",
  },
  {
    source: "typescript",
    ruleId: "TS2741",
    hint: "Property missing in type. Add missing property to object or make it optional in interface.",
    docUrl: "https://typescript.tv/errors/#ts2741",
  },
  {
    source: "typescript",
    ruleId: "TS7006",
    hint: "Parameter implicitly has 'any' type. Add explicit type annotation.",
    docUrl: "https://typescript.tv/errors/#ts7006",
  },
  {
    source: "typescript",
    ruleId: "TS2304",
    hint: "Cannot find name. Check imports, spelling, or declare the identifier.",
    docUrl: "https://typescript.tv/errors/#ts2304",
  },
  {
    source: "typescript",
    ruleId: "TS2307",
    hint: "Cannot find module. Check path, install package, or add type declarations.",
    docUrl: "https://typescript.tv/errors/#ts2307",
  },
  {
    source: "typescript",
    ruleId: "TS2551",
    hint: "Property doesn't exist. Did you mean a similar property name?",
    docUrl: "https://typescript.tv/errors/#ts2551",
  },
  {
    source: "typescript",
    ruleId: "TS2769",
    hint: "No overload matches this call. Check argument types against function overloads.",
    docUrl: "https://typescript.tv/errors/#ts2769",
  },

  // Biome Lint
  {
    source: "biome",
    ruleId: "lint/style/noVar",
    hint: "Replace 'var' with 'const' or 'let'.",
    fixPattern: "var -> const/let",
  },
  {
    source: "biome",
    ruleId: "lint/correctness/noUnusedVariables",
    hint: "Remove unused variable or prefix with underscore if intentional.",
    fixPattern: "Remove or prefix with _",
  },
  {
    source: "biome",
    ruleId: "lint/style/useConst",
    hint: "Variable is never reassigned. Use 'const' instead of 'let'.",
    fixPattern: "let -> const",
  },
  {
    source: "biome",
    ruleId: "lint/suspicious/noExplicitAny",
    hint: "Avoid 'any' type. Use specific type, 'unknown', or generic parameter.",
  },
  {
    source: "biome",
    ruleId: "lint/correctness/noUnusedImports",
    hint: "Remove unused import.",
    fixPattern: "Remove import",
  },
  {
    source: "biome",
    ruleId: "lint/complexity/noBannedTypes",
    hint: "Avoid banned types like {}. Use 'object', 'Record<string, unknown>', or specific type.",
  },

  // Go
  {
    source: "go",
    messagePattern: /undefined: (\w+)/,
    hint: "Undefined identifier. Check imports, spelling, or if exported (capitalized).",
  },
  {
    source: "go",
    messagePattern: /declared (and|but) not used/,
    hint: "Unused variable. Remove or use blank identifier (_).",
    fixPattern: "Remove or use _",
  },
  {
    source: "go",
    messagePattern: /cannot use .*? as .*? in/,
    hint: "Type mismatch. Check interface implementation or add type conversion.",
  },
  {
    source: "go",
    messagePattern: /imported and not used/,
    hint: 'Unused import. Remove or use blank import (_ "pkg").',
    fixPattern: "Remove import",
  },
  {
    source: "go",
    messagePattern: /no new variables on left side of :=/,
    hint: "All variables already declared. Use = instead of := for assignment.",
    fixPattern: ":= -> =",
  },

  // Go Test
  {
    source: "go-test",
    messagePattern: /FAIL: (\w+)/,
    hint: "Test failed. Check assertion values and test logic.",
  },
  {
    source: "go-test",
    messagePattern: /expected .*?, got/i,
    hint: "Assertion mismatch. Verify expected vs actual values match.",
  },
  {
    source: "go-test",
    messagePattern: /not equal/i,
    hint: "Equality assertion failed. Compare expected and actual values.",
  },
  {
    source: "go-test",
    messagePattern: /should be/i,
    hint: "Assertion failed. Check condition or expected value.",
  },
  {
    source: "go-test",
    messagePattern: /nil pointer dereference/,
    hint: "Nil pointer in test. Add nil check or ensure proper initialization.",
  },
  {
    source: "go-test",
    messagePattern: /panic:/,
    hint: "Test panicked. Check for nil pointers, out-of-bounds access, or missing setup.",
  },
  {
    source: "go-test",
    messagePattern: /timeout/i,
    hint: "Test timed out. Check for infinite loops, deadlocks, or increase timeout.",
  },

  // Vitest / Jest
  {
    source: "vitest",
    messagePattern: /expected .*? to (equal|be|match)/i,
    hint: "Assertion failed. Check expected vs actual values.",
  },
  {
    source: "vitest",
    messagePattern: /cannot read propert(y|ies) of (undefined|null)/i,
    hint: "Null/undefined access. Add null check or fix initialization.",
  },

  // Rust
  {
    source: "rust",
    messagePattern: /cannot find value `(\w+)` in this scope/,
    hint: "Value not in scope. Check spelling, imports, or declare variable.",
  },
  {
    source: "rust",
    messagePattern: /mismatched types/,
    hint: "Type mismatch. Check expected type and convert if needed.",
  },
  {
    source: "rust",
    messagePattern: /unused variable/,
    hint: "Unused variable. Prefix with underscore (_name) or remove.",
    fixPattern: "Prefix with _",
  },

  // Python
  {
    source: "python",
    messagePattern: /NameError: name '(\w+)' is not defined/,
    hint: "Undefined name. Check spelling, imports, or define variable.",
  },
  {
    source: "python",
    messagePattern: /TypeError: .*? takes \d+ positional argument/,
    hint: "Wrong number of arguments. Check function signature.",
  },
  {
    source: "python",
    messagePattern: /ImportError: cannot import name/,
    hint: "Import not found. Check spelling, circular imports, or install package.",
  },

  // ESLint
  {
    source: "eslint",
    ruleId: "no-unused-vars",
    hint: "Remove unused variable or prefix with underscore.",
    fixPattern: "Remove or prefix with _",
  },
  {
    source: "eslint",
    ruleId: "no-undef",
    hint: "Undefined variable. Add import, declare, or add to globals.",
  },
  {
    source: "eslint",
    ruleId: "@typescript-eslint/no-explicit-any",
    hint: "Avoid 'any' type. Use specific type, 'unknown', or generic.",
  },

  // Docker
  {
    source: "docker",
    messagePattern: /COPY failed: file not found/i,
    hint: "File not found during COPY. Check path relative to build context.",
  },
  {
    source: "docker",
    messagePattern: /failed to solve.*not found/i,
    hint: "Build stage or file not found. Check stage names and paths.",
  },
  {
    source: "docker",
    messagePattern: /returned a non-zero code: (\d+)/,
    hint: "Command failed in Dockerfile. Check RUN command output above.",
  },
  {
    source: "docker",
    messagePattern: /no matching manifest for/i,
    hint: "Image not found for platform. Check image name and platform compatibility.",
  },

  // Node.js
  {
    source: "nodejs",
    messagePattern: /Cannot find module '(.+)'/,
    hint: "Module not found. Run npm/yarn/bun install or check import path.",
  },
  {
    source: "nodejs",
    messagePattern: /SyntaxError: Unexpected token/,
    hint: "Syntax error. Check for missing brackets, commas, or invalid syntax.",
  },
  {
    source: "nodejs",
    messagePattern: /ERR_MODULE_NOT_FOUND/,
    hint: "ES module not found. Check file extension (.js/.mjs) and exports in package.json.",
  },
  {
    source: "nodejs",
    messagePattern: /ENOENT.*no such file/i,
    hint: "File not found. Check path exists and spelling is correct.",
  },

  // Infrastructure
  {
    source: "infrastructure",
    messagePattern: /timeout.*exceeded/i,
    hint: "Operation timed out. Check network, increase timeout, or reduce load.",
  },
  {
    source: "infrastructure",
    messagePattern: /connection refused/i,
    hint: "Connection refused. Check service is running and port is correct.",
  },
  {
    source: "infrastructure",
    messagePattern: /permission denied/i,
    hint: "Permission denied. Check file permissions or run with elevated privileges.",
  },

  // Metadata (build/config errors)
  {
    source: "metadata",
    messagePattern: /invalid.*configuration/i,
    hint: "Invalid configuration. Check config file syntax and required fields.",
  },
  {
    source: "metadata",
    messagePattern: /missing required/i,
    hint: "Missing required field. Check documentation for required configuration.",
  },

  // Generic (fallback patterns)
  {
    source: "generic",
    messagePattern: /error: (.+)/i,
    hint: "Check the error message for details and stack trace.",
  },
  {
    source: "generic",
    messagePattern: /failed/i,
    hint: "Operation failed. Check logs above for more context.",
  },
];
