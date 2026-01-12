import type { HealingTestCase } from "./types.js";

/**
 * Golden dataset of error scenarios for evaluation.
 *
 * Start small and expand as you encounter real CI failures.
 * Each case should represent a distinct error pattern.
 */
export const HEALING_DATASET: HealingTestCase[] = [
  {
    id: "ts-undefined-property",
    description:
      "TypeScript error: accessing property on potentially undefined",
    errorPrompt: `# CI Error Report

## Error 1: TypeScript Compilation Error
**File:** src/utils/config.ts:42
**Category:** type-check

\`\`\`
error TS2532: Object is possibly 'undefined'.

  40 |   const loadConfig = (path: string) => {
  41 |     const config = configs.get(path);
> 42 |     return config.value;
     |            ^^^^^^
  43 |   };
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["optional chaining", "?."],
      maxIterations: 5,
      maxCostUSD: 0.5,
    },
    tags: ["typescript", "type-check", "null-safety"],
  },

  {
    id: "go-unused-variable",
    description: "Go compilation error: declared but not used",
    errorPrompt: `# CI Error Report

## Error 1: Go Compilation Error
**File:** internal/handler/api.go:28
**Category:** compile

\`\`\`
./api.go:28:2: declared and not used: resp
\`\`\`

**Stack trace:**
\`\`\`
internal/handler/api.go:28:2
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      maxIterations: 3,
      maxCostUSD: 0.3,
    },
    tags: ["go", "compile", "unused-variable"],
  },

  {
    id: "jest-assertion-failure",
    description: "Jest test failure with expected vs received mismatch",
    errorPrompt: `# CI Error Report

## Error 1: Test Failure
**File:** src/services/auth.test.ts:45
**Category:** test

\`\`\`
FAIL src/services/auth.test.ts
  ● AuthService › validateToken › should return false for expired tokens

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      43 |     const token = createExpiredToken();
      44 |     const result = authService.validateToken(token);
    > 45 |     expect(result).toBe(false);
         |                    ^
      46 |   });
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["expired", "token", "validation"],
      maxIterations: 8,
      maxCostUSD: 0.8,
    },
    tags: ["jest", "test", "auth"],
  },

  {
    id: "eslint-unused-import",
    description: "ESLint error: unused import",
    errorPrompt: `# CI Error Report

## Error 1: Lint Error
**File:** src/components/Button.tsx:2
**Category:** lint

\`\`\`
error  'useState' is defined but never used  @typescript-eslint/no-unused-vars

  1 | import React from 'react';
> 2 | import { useState, useEffect } from 'react';
    |          ^^^^^^^^
  3 |
  4 | export const Button = ({ onClick, children }) => {
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      maxIterations: 3,
      maxCostUSD: 0.2,
    },
    tags: ["eslint", "lint", "unused-import"],
  },

  {
    id: "missing-dependency",
    description: "Module not found error",
    errorPrompt: `# CI Error Report

## Error 1: Module Resolution Error
**File:** src/index.ts:5
**Category:** compile

\`\`\`
Cannot find module 'lodash-es' or its corresponding type declarations.

  3 | import { config } from './config';
  4 | import { logger } from './logger';
> 5 | import { debounce } from 'lodash-es';
    | ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  6 |
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["install", "package.json", "lodash"],
      maxIterations: 5,
      maxCostUSD: 0.4,
    },
    tags: ["module", "dependency", "compile"],
  },

  // New test cases for expanded coverage

  {
    id: "python-import-error",
    description: "Python ModuleNotFoundError with missing dependency",
    errorPrompt: `# CI Error Report

## Error 1: Python Import Error
**File:** src/main.py:3
**Category:** runtime

\`\`\`
ModuleNotFoundError: No module named 'requests'

Traceback (most recent call last):
  File "src/main.py", line 3, in <module>
    import requests
ModuleNotFoundError: No module named 'requests'
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["requirements.txt", "pip", "install"],
      maxIterations: 4,
      maxCostUSD: 0.3,
    },
    tags: ["python", "dependency", "import"],
  },

  {
    id: "rust-borrow-checker",
    description: "Rust borrow checker error - cannot borrow as mutable",
    errorPrompt: `# CI Error Report

## Error 1: Rust Compilation Error
**File:** src/lib.rs:42
**Category:** compile

\`\`\`
error[E0502]: cannot borrow \`data\` as mutable because it is also borrowed as immutable
  --> src/lib.rs:42:5
   |
40 |     let ref_data = &data;
   |                    ----- immutable borrow occurs here
41 |     process(ref_data);
42 |     data.push(42);
   |     ^^^^^^^^^^^^ mutable borrow occurs here
43 |     println!("{:?}", ref_data);
   |                      -------- immutable borrow later used here
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      maxIterations: 6,
      maxCostUSD: 0.5,
    },
    tags: ["rust", "borrow-checker", "compile"],
  },

  {
    id: "react-hook-rules",
    description: "React hook called conditionally",
    errorPrompt: `# CI Error Report

## Error 1: ESLint Error (React Hooks)
**File:** src/components/UserProfile.tsx:15
**Category:** lint

\`\`\`
error  React Hook "useState" is called conditionally. React Hooks must be called in the exact same order in every component render  react-hooks/rules-of-hooks

  13 | export const UserProfile = ({ userId }) => {
  14 |   if (!userId) return null;
> 15 |   const [user, setUser] = useState(null);
     |                           ^^^^^^^^
  16 |
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["useState", "early return", "conditional"],
      maxIterations: 4,
      maxCostUSD: 0.3,
    },
    tags: ["react", "hooks", "lint"],
  },

  {
    id: "go-nil-pointer",
    description: "Go nil pointer dereference in test",
    errorPrompt: `# CI Error Report

## Error 1: Test Panic
**File:** internal/service/user_test.go:28
**Category:** test

\`\`\`
--- FAIL: TestGetUser (0.00s)
panic: runtime error: invalid memory address or nil pointer dereference [recovered]
        panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation]

goroutine 7 [running]:
testing.tRunner.func1.2({0x1234, 0x5678})
        /usr/local/go/src/testing/testing.go:1545 +0x238
internal/service.(*UserService).GetUser(0x0, {0x1234, 0x10})
        /app/internal/service/user.go:42 +0x1c
internal/service.TestGetUser(0xc000106820)
        /app/internal/service/user_test.go:28 +0x5c
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["nil", "initialize", "mock"],
      maxIterations: 6,
      maxCostUSD: 0.5,
    },
    tags: ["go", "test", "nil-pointer"],
  },

  {
    id: "ts-strict-null",
    description: "TypeScript strict null check with async/await",
    errorPrompt: `# CI Error Report

## Error 1: TypeScript Error
**File:** src/api/client.ts:55
**Category:** type-check

\`\`\`
error TS2345: Argument of type 'User | undefined' is not assignable to parameter of type 'User'.
  Type 'undefined' is not assignable to type 'User'.

  53 |   const user = await fetchUser(id);
  54 |   // user might be undefined if not found
> 55 |   return formatUserProfile(user);
     |                            ^^^^
  56 | }
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: true,
      expectedKeywords: ["undefined", "guard", "check"],
      maxIterations: 4,
      maxCostUSD: 0.3,
    },
    tags: ["typescript", "strict-null", "type-check"],
  },
];

/**
 * Get test cases by tag.
 */
export const getTestCasesByTag = (tag: string): HealingTestCase[] =>
  HEALING_DATASET.filter((tc) => tc.tags?.includes(tag));

/**
 * Get a single test case by ID.
 */
export const getTestCaseById = (id: string): HealingTestCase | undefined =>
  HEALING_DATASET.find((tc) => tc.id === id);
