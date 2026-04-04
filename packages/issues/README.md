# @obsr/issues

Issue-domain **Zod schemas** (`src/schema.ts`) are the single source of truth. OpenAI Responses calls use `@obsr/ai` only as transport; prompts live next to extraction/synthesis code.

## Model (conceptual)

| Layer | Role |
|--------|------|
| **Observation** | One capture from a stream (`ObservationSourceKind`: CI, manual log, Sentry, …) with context and diagnostic seeds. |
| **Diagnostic** | Normalized facts plus hierarchical fingerprints (`lore` / `repo` / `instance` keys) for dedupe and clustering. |
| **Issue aggregate** | Status, severity, linked diagnostics/observations, optional LLM **snapshot** (title, summary, plan). |

Pipeline: preprocess → extract → normalize (fingerprints, scrub) → synthesize.

## Key paths

- `src/schema.ts` — Zod contracts
- `src/preprocess.ts` — log preprocessing before extraction
- `src/extract.ts`, `src/snapshot.ts`, `src/prompt.ts` — LLM steps (via `@obsr/ai`)
- `src/normalize.ts`, `src/fingerprint.ts`, `src/fingerprint-normalize.ts`, `src/homoglyphs.ts` — fingerprints and sanitization
