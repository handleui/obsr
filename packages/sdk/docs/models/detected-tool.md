# DetectedTool

Hint for which tool produced the output. Auto-detected if omitted.

## Example Usage

```typescript
import { DetectedTool } from "@detent/sdk/models";

let value: DetectedTool = "typescript";
```

## Values

```typescript
"eslint" | "vitest" | "typescript" | "cargo" | "golangci"
```