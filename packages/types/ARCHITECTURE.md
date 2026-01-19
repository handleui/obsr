# @detent/types Architecture

Shared type definitions for the Detent platform. Primarily TypeScript interfaces with some utility functions.

---

## Module Graph

```
                          index.ts (barrel)
                               │
   ┌──────────┬───────────┬────┼────┬──────────┬──────────┬─────────────┬──────────┐
   ▼          ▼           ▼    ▼    ▼          ▼          ▼             ▼          ▼
category  severity    source context events context-parser fingerprint sanitize error
   .ts       .ts        .ts    .ts    .ts        .ts          .ts        .ts      .ts
   │          │           │      │
   └──────────┴───────────┴──────┘
                    │
                    ▼
                error.ts
             (core type)
```

---

## File Responsibilities

| File | Types/Exports | Purpose |
|------|---------------|---------|
| `category.ts` | ErrorCategory, AllCategories, isValidCategory | Classification (lint, type-check, test, compile...) |
| `severity.ts` | ErrorSeverity | error \| warning |
| `source.ts` | ErrorSource, ErrorSources | Tool attribution (biome, typescript, go...) |
| `context.ts` | CodeSnippet, WorkflowContext, cloneWorkflowContext | Source context + CI job/step info |
| `context-parser.ts` | ContextParser, LineContext, CIProvider, CIProviderID | CI log format parsing interface |
| `events.ts` | JobEvent, StepEvent, ManifestInfo, JobStatuses, StepStatuses | CI lifecycle events |
| `fingerprint.ts` | ErrorFingerprints, ErrorSignature, ErrorOccurrence | Error deduplication and tracking |
| `sanitize.ts` | RedactionPattern, redactPII, redactSensitiveData, sanitizeForTelemetry | PII/secret redaction utilities |
| `error.ts` | ExtractedError, MutableExtractedError | Core error representation |
| `index.ts` | — | Barrel exports |

---

## Core Type: ExtractedError

The canonical error representation used across all packages:

```
ExtractedError
├── Location
│   ├── filePath, line, column
│   └── lineKnown, columnKnown (validity flags)
│
├── Content
│   ├── message, raw, stackTrace
│   └── messageTruncated, stackTraceTruncated
│
├── Classification
│   ├── category (lint, type-check, test...)
│   ├── severity (error, warning)
│   ├── source (typescript, biome, go...)
│   └── ruleId (TS2749, no-var...)
│
├── Context
│   ├── workflowContext (job, step, action)
│   ├── workflowJob (flattened)
│   └── codeSnippet (surrounding code)
│
├── AI Hints
│   ├── suggestions (fix hints from tools)
│   ├── hint (actionable guidance)
│   └── fixable (auto-fixable by tool)
│
└── Metadata
    ├── unknownPattern (fallback parser match)
    ├── isInfrastructure (CI config vs code)
    ├── exitCode (process failure)
    └── possiblyTestOutput (noise detection)
```

---

## Design Patterns

### 1. Immutable by Default
All interface fields use `readonly`. Prevents accidental mutation.

```typescript
interface ExtractedError {
  readonly message: string;
  readonly filePath?: string;
  // ...
}
```

### 2. Mutable Builder Variant
`MutableExtractedError` enables incremental construction (multi-line parsing):

```typescript
// Build incrementally
const builder: MutableExtractedError = { message: "" };
builder.line = parsedLine;
builder.suggestions = [...]; // can push to array

// Freeze when done (in parser package)
const error: ExtractedError = freezeError(builder);
```

### 3. Const Objects for Values
Named constants with `as const` for type-safe access:

```typescript
export const ErrorSources = {
  TypeScript: "typescript" as const,
  Go: "go" as const,
  // ...
};

// Usage: ErrorSources.TypeScript  (autocomplete + refactor-safe)
```

### 4. Security Annotations
Fields containing PII/secrets are documented:

```typescript
/**
 * SECURITY: May contain user paths. Use redactPII() before external transmission.
 */
readonly filePath?: string;
```

---

## Consumers

| Package | Usage |
|---------|-------|
| `@detent/healing` | Reads ExtractedError for AI prompt generation, validation |
| `@detent/lore` | Uses ErrorFingerprints, ErrorSource for error signature tracking |
| `apps/api` | Stores/retrieves errors, uses ErrorCategory, ErrorSource, CodeSnippet |
| `apps/cli` | Uses redactSensitiveData for config sanitization |

---

## Scalability

### Current Strengths
- **Mostly types** — Minimal runtime code (sanitize utilities), tree-shakes well
- **Single responsibility** — One concept per file
- **Zero deps** — Only devDep on typescript

### Growth Strategies

**If ExtractedError grows too large:**
```typescript
// Split into composable interfaces
interface ErrorLocation { filePath?: string; line?: number; ... }
interface ErrorClassification { category?: ...; severity?: ...; }
interface ExtractedError extends ErrorLocation, ErrorClassification { ... }
```

**If package grows beyond ~15 types:**
```typescript
// Add subpath exports in package.json
"exports": {
  ".": "./dist/index.js",
  "./events": "./dist/events.js",
  "./context": "./dist/context.js"
}

// Usage: import { JobEvent } from "@detent/types/events"
```

**If breaking changes needed:**
- Bump major version
- Document in CHANGELOG.md
- Provide migration guide

---

## Conventions

- **Interfaces over type aliases** — Except for union types
- **Readonly by default** — Mutable variants explicit
- **Minimal runtime code** — Only security utilities (redaction) live here
- **JSDoc all public types** — Especially security-sensitive fields
