# DiagnosticSummary

Aggregated counts

## Example Usage

```typescript
import { DiagnosticSummary } from "@detent/sdk/models";

let value: DiagnosticSummary = {
  total: 5,
  errors: 3,
  warnings: 2,
};
```

## Fields

| Field                       | Type                        | Required                    | Description                 | Example                     |
| --------------------------- | --------------------------- | --------------------------- | --------------------------- | --------------------------- |
| `total`                     | *number*                    | :heavy_check_mark:          | Total number of diagnostics | 5                           |
| `errors`                    | *number*                    | :heavy_check_mark:          | Number of errors            | 3                           |
| `warnings`                  | *number*                    | :heavy_check_mark:          | Number of warnings          | 2                           |