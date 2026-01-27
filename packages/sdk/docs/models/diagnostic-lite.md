# DiagnosticLite

## Example Usage

```typescript
import { DiagnosticLite } from "@detent/sdk/models";

let value: DiagnosticLite = {
  message: "Cannot find name 'foo'",
  filePath: "src/app.ts",
  line: 10,
  column: 5,
};
```

## Fields

| Field                              | Type                               | Required                           | Description                        | Example                            |
| ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- |
| `message`                          | *string*                           | :heavy_check_mark:                 | Error or warning message           | Cannot find name 'foo'             |
| `filePath`                         | *string*                           | :heavy_minus_sign:                 | File path where the issue occurred | src/app.ts                         |
| `line`                             | *number*                           | :heavy_minus_sign:                 | Line number (1-indexed)            | 10                                 |
| `column`                           | *number*                           | :heavy_minus_sign:                 | Column number (1-indexed)          | 5                                  |