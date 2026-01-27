# Diagnostic

## Example Usage

```typescript
import { Diagnostic } from "@detent/sdk/models";

let value: Diagnostic = {
  message: "Cannot find name 'foo'",
  filePath: "src/app.ts",
  line: 10,
  column: 5,
  severity: "warning",
  ruleId: "TS2304",
};
```

## Fields

| Field                                              | Type                                               | Required                                           | Description                                        | Example                                            |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| `message`                                          | *string*                                           | :heavy_check_mark:                                 | Error or warning message                           | Cannot find name 'foo'                             |
| `filePath`                                         | *string*                                           | :heavy_minus_sign:                                 | File path where the issue occurred                 | src/app.ts                                         |
| `line`                                             | *number*                                           | :heavy_minus_sign:                                 | Line number (1-indexed)                            | 10                                                 |
| `column`                                           | *number*                                           | :heavy_minus_sign:                                 | Column number (1-indexed)                          | 5                                                  |
| `severity`                                         | [models.Severity](../models/severity.md)           | :heavy_check_mark:                                 | Issue severity level                               |                                                    |
| `ruleId`                                           | *string*                                           | :heavy_minus_sign:                                 | Tool-specific rule identifier                      | TS2304                                             |
| `stackTrace`                                       | *string*                                           | :heavy_minus_sign:                                 | Stack trace if available (e.g., for test failures) |                                                    |
| `suggestions`                                      | *string*[]                                         | :heavy_minus_sign:                                 | Suggested fixes from the tool                      |                                                    |
| `fixable`                                          | *boolean*                                          | :heavy_minus_sign:                                 | Whether the tool can auto-fix this issue           |                                                    |