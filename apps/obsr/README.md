# ObsR App

Next.js app for the active Observer issue workflow.

## Current AI Canon

- Reusable OpenAI Responses runtime lives in `@obsr/ai`.
- Shared issue-domain contracts live in `@obsr/issues`.
- Log extraction and issue synthesis use the official OpenAI SDK with the Responses API.
- Structured outputs use Zod-backed `text.format` schemas.
- Requests default to `store: false`.
- Vercel AI Gateway is only the routing endpoint when configured. It is not the app contract.
- `@obsr/extract` and `CIError` are not the active app model.
- Future solving is downstream from stored issues, not a second raw-log pipeline.

## Key Paths

- `src/lib/issues/adapters/text-log.ts`
- `src/lib/issues/adapters/sentry.ts`
- `src/lib/issues/issue-agent.ts`
- `src/lib/issues/schema.ts`

## Local Dev

```bash
bun run dev
```

App URL:

- `http://obsr.localhost:1355`
