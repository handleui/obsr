---
title: Supported Tools
description: What Detent can parse and fix
---

Detent parses structured output from your CI tools. The more context it has, the better the fixes.

## Linters

| Tool | Output Format | Setup |
|------|---------------|-------|
| **ESLint** | JSON | `--format json --output-file eslint-report.json` |
| **Biome** | JSON | `--reporter json > biome-report.json` |
| **golangci-lint** | JSON | `--out-format json > golangci-lint.json` |
| **Clippy** | JSON | `cargo clippy --message-format=json` |

## Type Checkers

| Tool | Output Format | Setup |
|------|---------------|-------|
| **TypeScript** | Text | `tsc --noEmit 2>&1 \| tee tsc-output.txt` |
| **Flow** | JSON | `flow check --json > flow.json` |

## Test Runners

| Tool | Output Format | Setup |
|------|---------------|-------|
| **Vitest** | JSON | Add `reporters: ['json']` to config |
| **Jest** | JSON | `--json --outputFile=jest.json` |
| **Go test** | JSON | `go test -json ./...` |
| **Cargo test** | JSON | `cargo test -- --format json` |

## Build Tools

| Tool | Notes |
|------|-------|
| **Cargo** | `--message-format=json` captures compile errors |
| **webpack** | Stats JSON via `--json` flag |
| **Next.js** | Build errors captured from stdout |

## Adding Output Files

By default, Detent looks for output files in:

- Repository root
- `./reports`
- `./test-results`
- `./coverage`

Name your files clearly: `eslint-report.json`, `vitest.json`, etc.

## What Makes a Good Fix

Detent works best when:

- Errors have file paths and line numbers
- Code snippets are available
- The fix is localized (not a refactor)

Complex logic bugs or architectural issues are flagged for human review instead of auto-fixed.

## Missing Your Tool?

[Request support](mailto:support@detent.sh) for additional tools.
