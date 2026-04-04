# @obsr/types

Cross-cutting **primitives** shared where importing `@obsr/issues` would be wrong (e.g. HTTP handlers that scrub before JSON).

## Owns

- `sanitize.ts` — path/secret scrubbing, telemetry helpers
- `IssueFingerprints` — shape for hierarchical diagnostic keys (see `@obsr/issues` for generation)

## Does not own

- Issue enums, observation types, or extraction results — use `@obsr/issues` (`schema.ts`)
