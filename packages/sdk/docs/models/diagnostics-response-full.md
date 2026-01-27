# DiagnosticsResponseFull

## Example Usage

```typescript
import { DiagnosticsResponseFull } from "@detent/sdk/models";

let value: DiagnosticsResponseFull = {
  mode: "full",
  detectedTool: "typescript",
  diagnostics: [],
  summary: {
    total: 5,
    errors: 3,
    warnings: 2,
  },
  truncated: true,
};
```

## Fields

| Field                                                       | Type                                                        | Required                                                    | Description                                                 | Example                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `mode`                                                      | *"full"*                                                    | :heavy_check_mark:                                          | Response mode indicator (discriminator)                     |                                                             |
| `detectedTool`                                              | *string*                                                    | :heavy_check_mark:                                          | Tool detected from output (null if unknown)                 | typescript                                                  |
| `diagnostics`                                               | [models.Diagnostic](../models/diagnostic.md)[]              | :heavy_check_mark:                                          | Parsed diagnostics from the log                             |                                                             |
| `summary`                                                   | [models.DiagnosticSummary](../models/diagnostic-summary.md) | :heavy_check_mark:                                          | Aggregated counts                                           |                                                             |
| `truncated`                                                 | *boolean*                                                   | :heavy_check_mark:                                          | True if diagnostics were truncated (max 10,000)             |                                                             |