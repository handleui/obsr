# @obsr/types Architecture

Shared type definitions for active Observer utilities.

This package is intentionally generic now. Legacy CI and resolver contracts moved to `legacy/types` as `@obsr/legacy-types`.

---

## Module Graph

```text
index.ts
  ├── category.ts
  ├── severity.ts
  ├── source.ts
  ├── events.ts
  ├── fingerprint.ts
  └── sanitize.ts
```

---

## File Responsibilities

| File | Types/Exports | Purpose |
|------|---------------|---------|
| `category.ts` | ErrorCategory, AllCategories, isValidCategory | Classification helpers |
| `severity.ts` | ErrorSeverity | `error` / `warning` |
| `source.ts` | ErrorSource, ErrorSources | Tool attribution helpers |
| `events.ts` | JobEvent, StepEvent, ManifestInfo, JobStatuses, StepStatuses | CI lifecycle metadata |
| `fingerprint.ts` | ErrorFingerprints, ErrorSignature, ErrorOccurrence | Error deduplication and tracking |
| `sanitize.ts` | RedactionPattern, redactPII, redactSensitiveData, sanitizeForTelemetry | PII / secret redaction utilities |
| `index.ts` | — | Barrel exports |

---

## Design Patterns

### 1. Const Objects for Values
Named constants with `as const` for type-safe access:

```typescript
export const ErrorSources = {
  TypeScript: "typescript" as const,
  Go: "go" as const,
};
```

### 2. Security Annotations
Fields containing PII/secrets are documented in the sanitization helpers.

---

## Consumers

| Package | Usage |
|---------|-------|
| `@obsr/issues` | Active issue-domain package for extraction, normalization, and synthesis |
| `@obsr/lore` | Uses ErrorFingerprints and ErrorSource for error signature tracking |
| `apps/obsr` | Uses redact/scrub helpers plus `@obsr/issues` for the active issue pipeline |
| `legacy/types` | Legacy-only CI/error contracts for old apps |
| `apps/cli` | Uses redactSensitiveData for config sanitization |

---

## Scalability

### Current Strengths
- **Mostly types** - Minimal runtime code (sanitize utilities), tree-shakes well
- **Single responsibility** - One concept per file
- **Zero deps** - Only devDep on typescript

### Growth Strategies

**If package grows beyond ~15 types:**
```typescript
// Add subpath exports in package.json
"exports": {
  ".": "./dist/index.js",
  "./events": "./dist/events.js",
  "./sanitize": "./dist/sanitize.js"
}
```

**If breaking changes are needed:**
- Bump major version
- Document in CHANGELOG.md
- Provide migration guide

---

## Conventions

- **Interfaces over type aliases** - Except for union types
- **Readonly by default** - Mutable variants explicit
- **Minimal runtime code** - Only security utilities (redaction) live here
- **JSDoc all public types** - Especially security-sensitive fields
