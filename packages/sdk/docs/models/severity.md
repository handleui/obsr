# Severity

Issue severity level

## Example Usage

```typescript
import { Severity } from "@detent/sdk/models";

let value: Severity = "warning";
```

## Values

This is an open enum. Unrecognized values will be captured as the `Unrecognized<string>` branded type.

```typescript
"error" | "warning" | Unrecognized<string>
```