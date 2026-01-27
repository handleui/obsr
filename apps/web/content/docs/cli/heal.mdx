---
title: Viewing Errors
description: See what failed and what Detent found
---

After your CI runs, you can view errors from the command line.

## Check Errors

```bash
dt errors
```

This shows errors for your current commit:

```
src/utils.ts
  typescript
    :42  Type 'string' is not assignable to type 'number'
    :58  Property 'foo' does not exist on type 'Bar'

src/api.ts
  eslint
    :12  Unexpected console statement

2 files · 3 errors
```

## Specify a Commit

```bash
dt errors --commit abc123
```

Or use a short SHA:

```bash
dt errors -c abc123
```

## JSON Output

For scripting or integrations:

```bash
dt errors --json
```

Returns structured data:

```json
{
  "commit": "abc123...",
  "repository": "acme/app",
  "totalErrors": 3,
  "files": {
    "src/utils.ts": {
      "typescript": [
        {"line": 42, "message": "Type 'string' is not assignable..."}
      ]
    }
  }
}
```

## No Errors?

If you see "No CI runs found", the commit hasn't been processed yet. Push to GitHub and wait for CI to complete.

## Next Steps

Errors are fixed automatically when AI healing is enabled. Check [Navigator](https://navigator.detent.sh) to see pending fixes and apply them.
