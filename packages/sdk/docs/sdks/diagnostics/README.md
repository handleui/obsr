# Diagnostics

## Overview

### Available Operations

* [postV1Diagnostics](#postv1diagnostics) - Parse CI/build logs into structured diagnostics

## postV1Diagnostics

Extracts structured error and warning information from raw CI/build log output.

Supports auto-detection of common tools (ESLint, TypeScript, Vitest, Cargo, golangci-lint) or accepts a hint via the `tool` parameter.

Returns parsed diagnostics with file locations, severity, and tool-specific metadata.

**Note:** Sensitive data (API keys, tokens, credentials) detected in the output is automatically redacted for security.

### Example Usage

<!-- UsageSnippet language="typescript" operationID="post_/v1/diagnostics" method="post" path="/v1/diagnostics" -->
```typescript
import { Detent } from "@detent/sdk";

const detent = new Detent();

async function run() {
  const result = await detent.diagnostics.postV1Diagnostics({
    content: "src/app.ts:10:5 - error TS2304: Cannot find name 'foo'",
  });

  console.log(result);
}

run();
```

### Standalone function

The standalone function version of this method:

```typescript
import { DetentCore } from "@detent/sdk/core.js";
import { diagnosticsPostV1Diagnostics } from "@detent/sdk/funcs/diagnostics-post-v1-diagnostics.js";

// Use `DetentCore` for best tree-shaking performance.
// You can create one instance of it to use across an application.
const detent = new DetentCore();

async function run() {
  const res = await diagnosticsPostV1Diagnostics(detent, {
    content: "src/app.ts:10:5 - error TS2304: Cannot find name 'foo'",
  });
  if (res.ok) {
    const { value: result } = res;
    console.log(result);
  } else {
    console.log("diagnosticsPostV1Diagnostics failed:", res.error);
  }
}

run();
```

### Parameters

| Parameter                                                                                                                                                                      | Type                                                                                                                                                                           | Required                                                                                                                                                                       | Description                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `request`                                                                                                                                                                      | [models.DiagnosticsRequest](../../models/diagnostics-request.md)                                                                                                               | :heavy_check_mark:                                                                                                                                                             | The request object to use for the request.                                                                                                                                     |
| `options`                                                                                                                                                                      | RequestOptions                                                                                                                                                                 | :heavy_minus_sign:                                                                                                                                                             | Used to set various options for making HTTP requests.                                                                                                                          |
| `options.fetchOptions`                                                                                                                                                         | [RequestInit](https://developer.mozilla.org/en-US/docs/Web/API/Request/Request#options)                                                                                        | :heavy_minus_sign:                                                                                                                                                             | Options that are passed to the underlying HTTP request. This can be used to inject extra headers for examples. All `Request` options, except `method` and `body`, are allowed. |
| `options.retries`                                                                                                                                                              | [RetryConfig](../../lib/utils/retryconfig.md)                                                                                                                                  | :heavy_minus_sign:                                                                                                                                                             | Enables retrying HTTP requests under certain failure conditions.                                                                                                               |

### Response

**Promise\<[models.DiagnosticsResponse](../../models/diagnostics-response.md)\>**

### Errors

| Error Type                | Status Code               | Content Type              |
| ------------------------- | ------------------------- | ------------------------- |
| errors.ErrorResponse      | 400                       | application/json          |
| errors.RateLimitError     | 429                       | application/json          |
| errors.DetentDefaultError | 4XX, 5XX                  | \*/\*                     |