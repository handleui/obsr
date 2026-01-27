---
title: Getting Started
description: Install and start parsing CI output
---

The `@detent/diagnostics` SDK parses output from CI tools into structured diagnostics. Zero dependencies, tree-shakeable, works offline.

## Install

::::scalar-tabs
:::scalar-tab{ title="npm" }
```bash
npm install @detent/diagnostics
```
:::

:::scalar-tab{ title="pnpm" }
```bash
pnpm add @detent/diagnostics
```
:::

:::scalar-tab{ title="bun" }
```bash
bun add @detent/diagnostics
```
:::
::::

## Quick Start

```ts
import { extract } from "@detent/diagnostics"

const output = `src/app.ts(10,5): error TS2304: Cannot find name 'foo'`
const result = extract(output)
```

Returns a structured result:

```ts
{
  detectedTool: "typescript",
  diagnostics: [{
    message: "Cannot find name 'foo'",
    filePath: "src/app.ts",
    line: 10,
    column: 5,
    severity: "error",
    ruleId: "TS2304"
  }],
  summary: { total: 1, errors: 1, warnings: 0 }
}
```

The tool is auto-detected from the output format. You can also specify it explicitly:

```ts
extract(output, "eslint")
```

## Supported Tools

| Tool | Format | Auto-detected |
|------|--------|---------------|
| ESLint | JSON (`--format json`) | Yes |
| TypeScript | Text (tsc output) | Yes |
| Vitest | JSON (`--reporter json`) | Yes |
| Cargo | NDJSON (`--message-format=json`) | Yes |
| golangci-lint | JSON (`--out-format=json`) | Yes |

:::scalar-callout{type="info"}
Need a tool that's not listed? See [Custom Parsers](/sdk/custom-parsers) to add support for any tool.
:::

## Core Types

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
  detectedTool: string | null
  diagnostics: Diagnostic[]
  summary: { total: number; errors: number; warnings: number }
}
```

## Next Steps

::::scalar-row
:::scalar-card{ icon="solid/programming-terminal" title="Run Commands" }
Execute commands and auto-extract diagnostics

[View Docs →](/sdk/running-commands)
:::

:::scalar-card{ icon="solid/basic-puzzle" title="Custom Parsers" }
Add support for any CI tool

[View Docs →](/sdk/custom-parsers)
:::
::::
