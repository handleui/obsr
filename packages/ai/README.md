# @obsr/ai

Thin **OpenAI Responses API** transport for the monorepo. Domain logic (issues, diagnostics, prompts) lives in `@obsr/issues`, not here.

## Owns

- Responses client creation, gateway base URL handling, structured output helpers (`zodTextFormat` from OpenAI helpers)
- Default model ids and token limits (`model-defaults.ts`)
- Model id resolution, usage/cost helpers, request error types (`ResponsesRequestError`, `isResponsesRequestError`)
- Optional caching knobs that map to Responses message shapes

## Does not own

- Issue categories, Zod issue schemas, fingerprint rules, extraction/synthesis prompts

## Future

A parallel adapter (e.g. Vercel AI SDK) could implement the same narrow surface used by `@obsr/issues` without moving schemas into this package.
