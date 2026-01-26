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

## Command Runner

Run commands and automatically extract diagnostics:

```ts
import { run, formatDiagnostics } from "@detent/diagnostics"

const result = await run("bun run test", { cwd: "/project" })
// {
//   stdout: "...",           // Raw stdout
//   stderr: "...",           // Raw stderr
//   diagnostics: {...},      // Parsed DiagnosticResult
//   exitCode: 1,
//   timedOut: false,
//   command: "bun run test --reporter json"  // Actual command run
// }

// For human-readable output:
console.log(formatDiagnostics(result.diagnostics))
// src/app.ts:10:5 - error TS2304: Cannot find name 'foo'
// 1 problem (1 error, 0 warnings)
```

The runner:
- Auto-detects the tool from the command
- Injects JSON output flags (e.g., `--reporter json` for vitest)
- Skips injection if conflicting flags are present
- Returns both raw output and parsed diagnostics

### Low-level: `prepareCommand()`

For tools with their own runners:

```ts
import { prepareCommand, extract } from "@detent/diagnostics"

const prepared = prepareCommand("bun run test")
// {
//   command: "bun run test --reporter json",
//   tool: "vitest",
//   outputSource: "stdout"
// }

// Run with your own runner
const { stdout } = await yourRunner(prepared.command)
const diagnostics = extract(stdout, prepared.tool)
```

## API Fallback

For unknown tools, optionally fall back to the Detent API:

```ts
import { createParser } from "@detent/diagnostics"

const parse = createParser({ apiKey: "your-api-key" })
// parse is an AsyncParser - returns Promise<DiagnosticResult>
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

### `run(command, options?)`

Execute a command and extract diagnostics.

```ts
const result = await run("bun run test", {
  cwd: "/project",
  env: { NODE_ENV: "test" },
  timeout: 60_000 // 1 minute
})
```

### `prepareCommand(command)`

Prepare a command with JSON flags without executing.

```ts
const { command, tool, outputSource } = prepareCommand("eslint src/")
// command: "eslint src/ --format json"
// tool: "eslint"
// outputSource: "stdout"
```

### `formatDiagnostics(result)`

Format diagnostics as human-readable text.

```ts
console.log(formatDiagnostics(result.diagnostics))
```

### `registerTool(config)` ✨

Register a custom tool with both command detection and parser in one call.

```ts
await registerTool({
  name: "pytest",
  commandPattern: /pytest/,
  jsonFlags: ["--json-report"],
  outputSource: "stdout",
  parse: (content) => {
    const data = JSON.parse(content)
    return data.tests
      .filter(t => t.outcome === "failed")
      .map(t => ({ message: t.longrepr, filePath: t.nodeid, severity: "error" }))
  }
})
```

### `registerToolConfig(config)`

Register command detection only (requires separate `registerParser()` call).

```ts
registerToolConfig({
  commandPattern: /pytest/,
  jsonFlags: ["--json-report"],
  outputSource: "stdout",
  parser: "pytest"
})
registerParser("pytest", myPytestParser)
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
  /** Tool name (built-in DetectedTool or custom registered parser name) */
  detectedTool: string | null
  diagnostics: Diagnostic[]
  summary: {
    total: number
    errors: number
    warnings: number
  }
}

type DetectedTool = "eslint" | "vitest" | "typescript" | "cargo" | "golangci"

// Type guard for narrowing string to DetectedTool
const isDetectedTool = (tool: string | null): tool is DetectedTool

interface RunResult {
  stdout: string
  stderr: string
  diagnostics: DiagnosticResult
  exitCode: number
  timedOut: boolean
  command: string
}

interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeout?: number  // default: 120000 (2 minutes)
}

interface PreparedCommand {
  command: string
  tool: string | null  // built-in or custom parser name
  outputSource: "stdout" | "stderr"
}

interface ToolConfig {
  commandPattern: RegExp
  jsonFlags: readonly string[]
  outputSource: "stdout" | "stderr"
  parser: string  // built-in or custom parser name
}

interface CustomToolConfig {
  name: string
  commandPattern: RegExp
  jsonFlags: readonly string[]
  outputSource: "stdout" | "stderr"
  parse: (content: string) => Diagnostic[]
}
```

## License

MIT
