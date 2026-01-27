# RateLimitError

## Example Usage

```typescript
import { RateLimitError } from "@detent/sdk/models/errors";

// No examples available for this model
```

## Fields

| Field                                     | Type                                      | Required                                  | Description                               | Example                                   |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| `error`                                   | *string*                                  | :heavy_check_mark:                        | Rate limit error message                  | Rate limit exceeded                       |
| `retryAfter`                              | *number*                                  | :heavy_check_mark:                        | Unix timestamp when the rate limit resets | 1706300000                                |