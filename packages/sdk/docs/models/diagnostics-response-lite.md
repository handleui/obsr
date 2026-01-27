# DiagnosticsResponseLite

## Example Usage

```typescript
import { DiagnosticsResponseLite } from "@detent/sdk/models";

let value: DiagnosticsResponseLite = {
  mode: "lite",
  detectedTool: "typescript",
  diagnostics: [
    {
      message: "Cannot find name 'foo'",
      filePath: "src/app.ts",
      line: 10,
      column: 5,
    },
  ],
  truncated: true,
};
```

## Fields

| Field                                                   | Type                                                    | Required                                                | Description                                             | Example                                                 |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| `mode`                                                  | *"lite"*                                                | :heavy_check_mark:                                      | Response mode indicator (discriminator)                 |                                                         |
| `detectedTool`                                          | *string*                                                | :heavy_check_mark:                                      | Tool detected from output (null if unknown)             | typescript                                              |
| `diagnostics`                                           | [models.DiagnosticLite](../models/diagnostic-lite.md)[] | :heavy_check_mark:                                      | Parsed diagnostics (minimal fields)                     |                                                         |
| `truncated`                                             | *boolean*                                               | :heavy_check_mark:                                      | True if diagnostics were truncated (max 10,000)         |                                                         |