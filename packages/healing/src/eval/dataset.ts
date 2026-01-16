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
  {
    id: "impossible-missing-file",
    description: "Error references non-existent file",
    errorPrompt: `# CI Error Report

## Error 1: TypeScript Error
**File:** src/does-not-exist.ts:10
**Category:** type-check

\`\`\`
error TS2307: Cannot find module './does-not-exist' or its corresponding type declarations.

  8 | import { run } from './runner';
  9 | import { config } from './config';
> 10 | import { missing } from './does-not-exist';
     |                          ^^^^^^^^^^^^^^^
 11 |
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["file not found", "does not exist"],
      maxIterations: 3,
    },
    tags: ["negative", "impossible"],
  },
  {
    id: "ambiguous-error",
    description: "Error too vague to fix automatically",
    errorPrompt: `# CI Error Report

## Error 1: Runtime Error
**File:** src/index.ts
**Category:** runtime

\`\`\`
Error: Something went wrong
    at main (src/index.ts:12)
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      maxIterations: 5,
    },
    tags: ["negative", "ambiguous"],
  },

  {
    id: "network-timeout-external-api",
    description: "Error caused by external API timeout - not a code problem",
    errorPrompt: `# CI Error Report

## Error 1: API Request Timeout
**File:** src/services/payment.ts:89
**Category:** test

\`\`\`
FAIL src/services/payment.test.ts
  ● PaymentService › processPayment › should charge customer

    Error: connect ETIMEDOUT 203.0.113.42:443

      87 |   const response = await fetch(STRIPE_API_URL, {
      88 |     method: 'POST',
    > 89 |     body: JSON.stringify(payload),
         |           ^
      90 |   });

    at TCPConnectWrap.afterConnect [as oncomplete] (net.js:1141:16)
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["network", "external", "infrastructure", "timeout"],
      maxIterations: 4,
    },
    tags: ["negative", "infrastructure"],
  },

  {
    id: "missing-api-key-env",
    description: "Error caused by missing API key environment variable",
    errorPrompt: `# CI Error Report

## Error 1: Authentication Failure
**File:** src/config/api.ts:15
**Category:** runtime

\`\`\`
Error: Missing required environment variable: OPENAI_API_KEY

    at validateConfig (src/config/api.ts:15:11)
    at Object.<anonymous> (src/config/api.ts:28:1)
    at Module._compile (internal/modules/cjs/loader.js:1085:14)

The OPENAI_API_KEY environment variable is required but was not found.
Please set it in your .env file or CI secrets.
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["environment", "secret", "API key", "credential"],
      maxIterations: 3,
    },
    tags: ["negative", "credentials"],
  },

  {
    id: "database-connection-refused",
    description: "Error caused by unreachable database - infrastructure issue",
    errorPrompt: `# CI Error Report

## Error 1: Database Connection Error
**File:** src/db/connection.ts:23
**Category:** test

\`\`\`
FAIL src/repositories/user.test.ts
  ● UserRepository › findById › should return user

    Error: connect ECONNREFUSED 127.0.0.1:5432

    Could not connect to PostgreSQL database.
    Connection details:
      Host: localhost
      Port: 5432
      Database: app_test

      21 |   const pool = new Pool({
      22 |     connectionString: process.env.DATABASE_URL,
    > 23 |   });
         |   ^
      24 |

    at Connection._handleErrorEvent (node_modules/pg/lib/connection.js:128:12)
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["database", "connection", "infrastructure"],
      maxIterations: 4,
    },
    tags: ["negative", "infrastructure"],
  },

  {
    id: "out-of-memory-heap",
    description: "Process killed due to memory exhaustion",
    errorPrompt: `# CI Error Report

## Error 1: Out of Memory
**File:** unknown
**Category:** runtime

\`\`\`
<--- Last few GCs --->

[1234:0x5555555555] 123456 ms: Mark-sweep 2047.9 (2051.3) -> 2047.1 (2051.3) MB, 1892.5 / 0.0 ms

<--- JS stacktrace --->

FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory

 1: 0xb090e0 node::Abort()
 2: 0xa1b70e v8::Utils::ReportOOMFailure()
 3: 0xa1b944 v8::internal::V8::FatalProcessOutOfMemory()

npm ERR! code ELIFECYCLE
npm ERR! errno 134
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["memory", "heap", "resource", "OOM"],
      maxIterations: 3,
    },
    tags: ["negative", "resource-limits"],
  },

  {
    id: "node-version-incompatible",
    description: "Error due to incompatible Node.js version in CI",
    errorPrompt: `# CI Error Report

## Error 1: Syntax Error
**File:** src/index.ts:1
**Category:** runtime

\`\`\`
/app/node_modules/.pnpm/some-package@2.0.0/node_modules/some-package/dist/index.js:1
const x = globalThis.structuredClone ?? (() => { throw new Error() });
                     ^^^^^^^^^^^^^^^

SyntaxError: Unexpected identifier

    at wrapSafe (internal/modules/cjs/loader.js:915:16)
    at Module._compile (internal/modules/cjs/loader.js:963:27)

Node.js version: v14.17.0
Required: >=18.0.0
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["Node", "version", "environment", "incompatible"],
      maxIterations: 4,
    },
    tags: ["negative", "environment"],
  },

  {
    id: "flaky-race-condition",
    description: "Test fails intermittently due to race condition",
    errorPrompt: `# CI Error Report

## Error 1: Flaky Test Failure
**File:** src/workers/queue.test.ts:67
**Category:** test

\`\`\`
FAIL src/workers/queue.test.ts
  ● QueueWorker › processJob › should complete job in order

    expect(received).toEqual(expected)

    Expected: ["job-1", "job-2", "job-3"]
    Received: ["job-2", "job-1", "job-3"]

      65 |     await worker.processAll();
      66 |     const results = await getCompletedJobs();
    > 67 |     expect(results).toEqual(['job-1', 'job-2', 'job-3']);
         |                     ^
      68 |   });

    Note: This test passed in 47 out of 50 previous runs.
    Test history: PASS PASS FAIL PASS PASS PASS FAIL PASS ...
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["flaky", "race condition", "intermittent", "timing"],
      maxIterations: 5,
    },
    tags: ["negative", "flaky"],
  },

  {
    id: "breaking-change-migration",
    description: "Error requires architectural decision about data migration",
    errorPrompt: `# CI Error Report

## Error 1: Schema Migration Conflict
**File:** drizzle/0015_add_user_preferences.sql
**Category:** migrate

\`\`\`
Error: Migration failed

ALTER TABLE "users" ADD COLUMN "preferences" jsonb NOT NULL;

ERROR: column "preferences" of relation "users" contains null values

The migration cannot proceed because:
- 847,293 existing user records have no default value
- Adding NOT NULL constraint would violate data integrity
- Options require business decision:
  1. Use DEFAULT '{}' (empty preferences for all)
  2. Backfill from legacy settings table first
  3. Make column nullable initially

This requires manual intervention to decide migration strategy.
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["migration", "decision", "business", "manual"],
      maxIterations: 4,
    },
    tags: ["negative", "architectural"],
  },

  {
    id: "dependency-version-conflict",
    description: "Peer dependency conflict that requires human resolution",
    errorPrompt: `# CI Error Report

## Error 1: Dependency Resolution Failed
**File:** package.json
**Category:** install

\`\`\`
npm ERR! code ERESOLVE
npm ERR! ERESOLVE could not resolve
npm ERR!
npm ERR! While resolving: @company/design-system@3.0.0
npm ERR! Found: react@18.2.0
npm ERR! node_modules/react
npm ERR!   react@"^18.2.0" from the root project
npm ERR!   peer react@"^17.0.2 || ^18.0.0" from @mui/material@5.14.0
npm ERR!
npm ERR! Could not resolve dependency:
npm ERR! peer react@"^17.0.2" from @company/legacy-charts@2.1.0
npm ERR! node_modules/@company/legacy-charts
npm ERR!   @company/legacy-charts@"^2.1.0" from the root project
npm ERR!
npm ERR! Conflicting peer dependency: react@17.0.2
npm ERR!
npm ERR! Fix the upstream dependency conflict, or retry with --force or --legacy-peer-deps

Upgrade paths available:
- Upgrade @company/legacy-charts to v3.x (breaking API changes)
- Downgrade react to 17.x (loses React 18 features)
- Fork @company/legacy-charts (maintenance burden)
\`\`\`

Please fix this error following the research → understand → fix → verify workflow.`,
    expected: {
      shouldSucceed: false,
      expectedKeywords: ["dependency", "conflict", "peer", "resolution"],
      maxIterations: 4,
    },
    tags: ["negative", "dependencies"],
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
