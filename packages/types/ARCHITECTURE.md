# @obsr/types Architecture

Shared type definitions for active Observer packages. Primarily TypeScript interfaces with a small set of sanitization helpers.

---

## Module Graph

```
                          index.ts (barrel)
                               │
   ┌──────────┬───────────┬────┼────┬──────────┬──────────┬─────────────┬──────────┬────────────┐
   ▼          ▼           ▼    ▼    ▼          ▼          ▼             ▼          ▼            ▼
category  severity    source context events context-parser fingerprint sanitize error    diagnostic
   .ts       .ts        .ts    .ts    .ts        .ts          .ts        .ts      .ts         .ts
                                                                                               │
                                                                                   ┌───────────┤
                                                                                   ▼           ▼
                                                                              CIError    CIErrorSchema
                                                                           (core type)   (validation)
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
| `error.ts` | ExtractedError, MutableExtractedError | Core error representation (deprecated, use diagnostic.ts) |
| `diagnostic.ts` | CIError, CIErrorSchema, CodeSnippetSchema, WorkflowContextSchema | Unified CI error schema with Zod validation |
| `index.ts` | — | Barrel exports |

---

## Core Type: CIError

The unified CI error schema used across all packages. Defined in `diagnostic.ts` with Zod validation.

```
CIError
├── Core
│   └── message (required, max 10k chars)
│
├── Location
│   ├── filePath (max 1k chars)
│   ├── line (1-indexed)
│   └── column
│
├── Classification
│   ├── severity (error, warning)
│   ├── category (lint, type-check, test, compile, runtime...)
│   ├── source (biome, eslint, typescript, go, vitest...)
│   └── ruleId (TS2304, no-unused-vars...)
│
├── Context
│   ├── raw (original tool output)
│   ├── stackTrace (for test/runtime errors)
│   ├── codeSnippet { lines, startLine, errorLine, language }
│   └── hints (fix suggestions from tool)
│
├── Metadata
│   ├── fixable (tool can auto-fix)
│   └── relatedFiles (parsed from stackTrace)
│
└── Workflow (action enriches)
    ├── workflowContext { job, step, action }
    └── workflowJob (flattened)
```

**Data flow**: parsers populate location/classification → AI extraction adds context/hints → analysis flow enriches with workflow info.

### Deprecated: ExtractedError

`ExtractedError` and `MutableExtractedError` in `error.ts` are deprecated aliases for `CIError`. They exist for backward compatibility but all new code should use `CIError` and `CIErrorSchema`.

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
| `@obsr/extract` | Uses CIError, CIErrorSchema for error extraction and validation |
| `@obsr/lore` | Uses ErrorFingerprints, ErrorSource for error signature tracking |
| `apps/obsr` | Uses redact/scrub helpers and CIError-derived contracts for analysis flow |
| `legacy/api` | Historical reference only |
| `apps/cli` | Uses redactSensitiveData for config sanitization |

---

## Scalability

### Current Strengths
- **Mostly types** — Minimal runtime code (sanitize utilities), tree-shakes well
- **Single responsibility** — One concept per file
- **Zero deps** — Only devDep on typescript

### Growth Strategies

**If CIError grows too large:**
```typescript
// Split into composable schemas
const ErrorLocationSchema = z.object({ filePath: ..., line: ..., column: ... });
const ErrorClassificationSchema = z.object({ category: ..., severity: ..., source: ... });
const CIErrorSchema = ErrorLocationSchema.merge(ErrorClassificationSchema).extend({ ... });
```

**If package grows beyond ~15 types:**
```typescript
// Add subpath exports in package.json
"exports": {
  ".": "./dist/index.js",
  "./events": "./dist/events.js",
  "./context": "./dist/context.js"
}

// Usage: import { JobEvent } from "@obsr/types/events"
```

**If breaking changes are needed:**
- Bump major version
- Document in CHANGELOG.md
- Provide migration guide

---

## Conventions

- **Interfaces over type aliases** — Except for union types
- **Readonly by default** — Mutable variants explicit
- **Minimal runtime code** — Only security utilities (redaction) live here
- **JSDoc all public types** — Especially security-sensitive fields
