# DiagnosticsRequest

## Example Usage

```typescript
import { DiagnosticsRequest } from "@detent/sdk/models";

let value: DiagnosticsRequest = {
  content: "src/app.ts:10:5 - error TS2304: Cannot find name 'foo'",
};
```

## Fields

| Field                                                                                    | Type                                                                                     | Required                                                                                 | Description                                                                              | Example                                                                                  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `content`                                                                                | *string*                                                                                 | :heavy_check_mark:                                                                       | Raw CI/build log content to parse                                                        | src/app.ts:10:5 - error TS2304: Cannot find name 'foo'                                   |
| `tool`                                                                                   | [models.DetectedTool](../models/detected-tool.md)                                        | :heavy_minus_sign:                                                                       | Hint for which tool produced the output. Auto-detected if omitted.                       |                                                                                          |
| `mode`                                                                                   | [models.ModeEnum](../models/mode-enum.md)                                                | :heavy_minus_sign:                                                                       | Response detail level. 'full' includes severity, ruleId, suggestions. 'lite' is minimal. |                                                                                          |