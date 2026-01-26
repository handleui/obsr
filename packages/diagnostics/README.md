# @detent/diagnostics

Parse CI tool output into structured diagnostics. Zero dependencies, tree-shakeable.

## Install

```bash
npm install @detent/diagnostics
```

## Quick Start

```ts
import { extract } from "@detent/diagnostics"

const output = `src/app.ts(10,5): error TS2304: Cannot find name 'foo'`
const result = extract(output)
// {
//   detectedTool: "typescript",
//   diagnostics: [{ message: "Cannot find name 'foo'", ... }],
//   summary: { total: 1, errors: 1, warnings: 0 }
// }
```

## Supported Tools

| Tool | Format |
|------|--------|
| ESLint | JSON (`--format json`) |
| TypeScript | Text (tsc output) |
| Vitest | JSON (`--reporter json`) |
| Cargo | NDJSON (`--message-format=json`) |
| golangci-lint | JSON (`--out-format=json`) |

## Custom Parsers

```ts
import { registerParser, extract } from "@detent/diagnostics"

registerParser("jest", (content) => {
  const json = JSON.parse(content)
  return json.testResults.flatMap(file =>
    file.assertionResults
      .filter(r => r.status === "failed")
      .map(r => ({
        message: r.failureMessages.join("\n"),
        filePath: file.name,
        severity: "error"
      }))
  )
})

const result = extract(jestOutput, "jest")
```

## API Fallback

For unknown tools, optionally fall back to the Detent API:

```ts
import { createParser } from "@detent/diagnostics"

const parse = createParser({ apiKey: "your-api-key" })
const result = await parse(unknownOutput)
```

## API

### `extract(content, tool?)`

Synchronous, local-only parsing. Auto-detects the tool if not specified.

```ts
const result = extract(tscOutput)
// result.detectedTool === "typescript"
```

### `detectTool(content)`

Detect which tool produced the output.

```ts
const tool = detectTool(output) // "eslint" | "typescript" | ...
```

### `registerParser(name, parser)`

Register a custom parser for unsupported tools.

```ts
registerParser("myTool", (content) => [
  { message: "error found", severity: "error" }
])
```

### `createParser(options?)`

Create an async parser with optional API fallback.

```ts
const parse = createParser({
  apiKey: "...",
  apiUrl: "https://custom.api/diagnostics" // optional
})
const result = await parse(output)
```

## Types

```ts
interface Diagnostic {
  message: string
  filePath?: string
  line?: number
  column?: number
  severity?: "error" | "warning"
  ruleId?: string
  stackTrace?: string
  suggestions?: string[]
  fixable?: boolean
}

interface DiagnosticResult {
  detectedTool: DetectedTool | null
  diagnostics: Diagnostic[]
  summary: {
    total: number
    errors: number
    warnings: number
  }
}

type DetectedTool = "eslint" | "vitest" | "typescript" | "cargo" | "golangci"
```

## License

MIT
