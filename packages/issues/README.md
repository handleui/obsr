# @obsr/issues

Shared issue-domain package for Observer.

## Canon

- `@obsr/ai` owns the reusable OpenAI-first Responses runtime.
- `@obsr/issues` is the source of truth for issue extraction, normalization, and synthesis.
- New issue-domain code should consume the runtime through `@obsr/ai`.
- Structured output uses strict `text.format: { type: "json_schema" }`.
- Requests are stateless by default with `store: false`.
- Direct OpenAI is the preferred default when an OpenAI API key is configured.
- Vercel AI Gateway is an optional routing endpoint through an OpenAI-compatible `baseURL`.
- Future solving belongs in a separate downstream package, not here.

## Not Canon

- Do not add new code to `@obsr/extract`.
- Do not model the active ObsR issue pipeline around `CIError`.
- Do not treat Vercel AI SDK helpers as the product boundary for extraction or synthesis.
