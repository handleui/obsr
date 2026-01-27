---
title: Running Commands
description: Execute commands and automatically extract diagnostics
---

Instead of manually capturing output and parsing it, use `run()` to execute commands and get structured diagnostics in one step.

## Basic Usage

```ts
import { run } from "@detent/diagnostics"

const result = await run("npm test")
```

Returns:

```ts
{
  stdout: "...",                              // Raw stdout
  stderr: "...",                              // Raw stderr
  diagnostics: { detectedTool, diagnostics, summary },
  exitCode: 1,
  timedOut: false,
  bufferExceeded: false,
  command: "npm test --reporter json"         // Actual command executed
}
```

## How It Works

The runner automatically:

1. **Detects the tool** from the command (e.g., `vitest`, `eslint`, `tsc`)
2. **Injects JSON flags** to get machine-readable output
3. **Parses the output** using the appropriate parser
4. **Returns both** raw output and structured diagnostics

For example, `bun test` becomes `bun test --reporter json` because the runner detects Vitest.

## Options

```ts
const result = await run("npm test", {
  cwd: "/path/to/project",       // Working directory
  env: { NODE_ENV: "test" },     // Environment variables (merged with process.env)
  timeout: 60_000,               // Timeout in ms (default: 120000)
  maxBuffer: 50 * 1024 * 1024    // Max buffer size (default: 50MB)
})
```

## Formatting Output

Use `formatDiagnostics()` to get human-readable output:

```ts
import { run, formatDiagnostics } from "@detent/diagnostics"

const result = await run("npm test")
console.log(formatDiagnostics(result.diagnostics))
```

Output:

```
src/app.ts:10:5 - error TS2304: Cannot find name 'foo'
src/utils.ts:25:1 - warning: 'unused' is defined but never used

2 problems (1 error, 1 warning)
```

## Low-Level: prepareCommand()

If you have your own process runner, use `prepareCommand()` to get the modified command without executing:

```ts
import { prepareCommand, extract } from "@detent/diagnostics"

const prepared = prepareCommand("eslint src/")
// {
//   command: "eslint src/ --format json",
//   tool: "eslint",
//   outputSource: "stdout"
// }

// Run with your own runner
const { stdout } = await yourRunner(prepared.command)
const diagnostics = extract(stdout, prepared.tool)
```

This is useful when integrating with existing build systems or custom execution environments.

## Handling Failures

The runner doesn't throw on non-zero exit codes. Check the result:

```ts
const result = await run("npm test")

if (result.exitCode !== 0) {
  if (result.timedOut) {
    console.log("Command timed out")
  } else if (result.bufferExceeded) {
    console.log("Output too large")
  } else {
    console.log(`Failed with ${result.diagnostics.summary.errors} errors`)
  }
}
```

:::scalar-callout{type="warning"}
The `command` parameter is passed to the shell. Don't pass untrusted user input directly.
:::
