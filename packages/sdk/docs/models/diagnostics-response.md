# DiagnosticsResponse


## Supported Types

### `models.DiagnosticsResponseFull`

```typescript
const value: models.DiagnosticsResponseFull = {
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

### `models.DiagnosticsResponseLite`

```typescript
const value: models.DiagnosticsResponseLite = {
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

