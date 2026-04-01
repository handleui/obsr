# @obsr/lore

## 0.2.1

### Patch Changes

- e1cb50b: Migrate from @obsr/parser to @obsr/types for shared type imports.
- Updated dependencies [e1cb50b]
  - @obsr/types@0.5.0

## 0.2.0

### Minor Changes

- 74eab1c: Add hierarchical error fingerprinting with `generateFingerprints()`.
  Produces lore (cross-repo), repo (per-project), and instance (exact location) fingerprints.
  Includes message normalization and sensitive data sanitization for safe storage.

### Patch Changes

- Updated dependencies [74eab1c]
- Updated dependencies [74eab1c]
  - @obsr/parser@0.7.0
  - @obsr/types@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [6bfca1a]
- Updated dependencies [6bfca1a]
  - @obsr/parser@0.6.0

## 0.1.1

### Patch Changes

- Updated dependencies [5fa4de0]
  - @obsr/parser@0.5.3

## 0.1.0

### Minor Changes

- 2c9889d: Add error hints system for matching CI errors against known patterns.
  Provides contextual hints to guide AI error fixing, with 40+ rules covering TypeScript, Go, Biome, Python, Rust, Docker, and more.
