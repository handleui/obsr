# Parser Package Architecture

CI log parser that extracts structured errors from build output. Two-layer design: **context parsers** strip CI format, **tool parsers** match error content.

## Structure

```
src/
├── context/           # CI log FORMAT parsers
│   ├── github.ts      # GitHub Actions (strips timestamps, tracks ##[group])
│   ├── act.ts         # Act local runner (strips [Job/Step] prefixes)
│   ├── gitlab.ts      # GitLab CI
│   └── passthrough.ts # No-op for raw logs
├── parsers/           # Tool error CONTENT parsers
│   ├── golang.ts      # Go compiler/test (multi-line panic)
│   ├── typescript.ts  # TS compiler errors
│   ├── python.ts      # Python tracebacks
│   ├── rust.ts        # Rust compiler
│   ├── vitest.ts      # Vitest test failures
│   ├── biome.ts       # Biome linter
│   ├── eslint.ts      # ESLint
│   ├── infrastructure.ts  # npm/Docker/git/shell
│   ├── github-annotations.ts  # ::error file=...:: format
│   └── generic.ts     # Fallback (strict validation)
├── events/            # CI job/step lifecycle types
├── index.ts           # Public API
├── extractor.ts       # Core extraction loop + deduplication
├── registry.ts        # Parser registration + priority matching
├── parser-types.ts    # ToolParser interface
├── types.ts           # ExtractedError, ErrorReport
├── utils.ts           # stripAnsi, file helpers
├── severity.ts        # Infer error/warning from category
├── sanitize.ts        # PII redaction (AWS keys, tokens)
├── snippet.ts         # Code context extraction
└── exit-codes.ts      # Exit code → category mapping
```

## Data Flow

```
CI Logs
  ↓
Context Parser ─── strips timestamps, prefixes
  ↓
Extractor ─── orchestrates parsing, deduplicates
  ├→ Tool Parsers (priority order)
  ├→ Noise Checker
  └→ Multi-line Handler (stack traces)
  ↓
ExtractedError[]
  ↓
Post-Processing
  ├→ Severity inference
  ├→ Code snippets
  └→ PII sanitization
  ↓
ErrorReport
```

## Priority System

Higher priority = checked first. Parser with highest `canParse()` confidence wins.

| Priority | Parsers |
|----------|---------|
| 95 | GitHub Annotations |
| 80 | Language (Go, Python, Rust, TS, Vitest) |
| 75 | Linters (Biome, ESLint) |
| 70 | Infrastructure (npm, Docker, git) |
| 10 | Generic fallback |

## API

**Simple (singleton, auto-resets):**
```typescript
import { parse, parseActLogs, parseGitHubLogs } from '@detent/parser'

const errors = parse(logs)           // Auto-detect CI
const errors = parseActLogs(logs)    // Force Act format
const errors = parseGitHubLogs(logs) // Force GitHub format
```

**Advanced (custom registry):**
```typescript
import { createRegistry, createExtractor, createGitHubContextParser } from '@detent/parser'

const registry = createRegistry()
// Register custom parsers...
const extractor = createExtractor(registry)
const errors = extractor.extract(logs, createGitHubContextParser())
```

## Writing a Parser

Implement `ToolParser` interface or extend `BaseParser`:

```typescript
import { BaseParser, type ParseContext, type ExtractedError } from '@detent/parser'

export class MyParser extends BaseParser {
  readonly id = 'my-tool'
  readonly priority = 75

  canParse(line: string, ctx: ParseContext): number {
    // Return 0.0-1.0 confidence
    return line.includes('MY_ERROR:') ? 0.9 : 0
  }

  parse(line: string, ctx: ParseContext): ExtractedError | null {
    const match = line.match(/MY_ERROR: (.+) at (.+):(\d+)/)
    if (!match) return null
    return {
      message: match[1],
      file: match[2],
      line: Number(match[3]),
      severity: 'error',
      category: 'compile',
      source: 'my-tool',
    }
  }
}
```

For multi-line (stack traces), extend `MultiLineParser` and implement:
- `continueMultiLine(line, ctx): boolean` – return true to keep accumulating
- `finishMultiLine(ctx): ExtractedError | null` – build final error

## Key Types

```typescript
interface ExtractedError {
  message: string
  file?: string
  line?: number
  column?: number
  severity: 'error' | 'warning'
  category: 'lint' | 'type-check' | 'test' | 'compile' | 'runtime' | ...
  source: 'go' | 'typescript' | 'python' | 'biome' | ...
  ruleId?: string
  stackTrace?: string
  suggestions?: string[]
  codeSnippet?: CodeSnippet
  workflowContext?: WorkflowContext
}

interface ErrorReport {
  errors: ExtractedError[]
  stats: ErrorStats  // counts by category/source/file
  aiContext: object  // extraction metadata
}
```

## Security

- **Line limit**: 65KB max per line
- **Dedup limit**: 10K errors max
- **PII redaction**: AWS keys, tokens, credentials auto-stripped
- **Protected files**: Won't read .env, .pem for snippets
- **ReDoS prevention**: Anchored patterns, bounded quantifiers

## Testing

```bash
bun test packages/parser
```

Test files in `src/__tests__/` cover each parser, the extractor, and registry.
