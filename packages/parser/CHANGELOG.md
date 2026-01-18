# @detent/parser

## 0.7.0

### Minor Changes

- 74eab1c: Add `fixable` field to Biome parser output.
  Extracts FIXABLE marker from Biome console format headers to indicate auto-fixable errors.

### Patch Changes

- Updated dependencies [74eab1c]
  - @detent/types@0.4.0

## 0.6.0

### Minor Changes

- 6bfca1a: Add CI provider abstraction with auto-detection and plugin support.
  Includes GitLab CI parser, GitHub Actions annotation parser, and runtime
  registration APIs for tool patterns, extension mappings, and custom providers.
  Adds concurrent usage detection for singleton parsers with warnings.

### Patch Changes

- 6bfca1a: Refactor to use shared types from @detent/types.
  Re-exports foundational types for backwards compatibility.
- Updated dependencies [6bfca1a]
  - @detent/types@0.3.0

## 0.5.3

### Patch Changes

- 5fa4de0: Refactor to use shared types from @detent/types.
  Re-exports foundational types for backwards compatibility.
- Updated dependencies [5fa4de0]
  - @detent/types@0.2.0

## 0.5.2

### Patch Changes

- d91ffbd: Fix false positive annotations from vitest parser when errors appear in test output context.
  Add test output context tracking to prevent mock errors and console output from being annotated.

## 0.5.1

### Patch Changes

- b4c69a9: Filter out internal vitest runner stack frames and CI wrapper errors for cleaner output

## 0.5.0

### Minor Changes

- db9f7a4: Add detection for unsupported tools (Jest, Prettier, Playwright, Cypress, webpack, etc.).
  Includes helper functions `isUnsupportedToolID` and `getUnsupportedToolDisplayName` for
  identifying and displaying tools that are detected but lack dedicated parsers.

## 0.4.0

### Minor Changes

- fe49914: Add step tracking to GitHub Actions context parser. The parser now extracts step names
  from ##[group] markers and maintains step context across log lines, enabling errors
  to be associated with their originating workflow step. Includes security measures for
  input truncation and bounded regex patterns.

## 0.3.0

### Minor Changes

- 6826a95: Add Vitest test runner parser for extracting test failures from CI logs.
  Supports FAIL markers, assertion errors with diff output, stack trace extraction,
  and multi-line error accumulation. Includes ReDoS prevention, resource limits,
  and comprehensive noise filtering for Vitest output patterns.

## 0.2.0

### Minor Changes

- f747d88: Add Biome linter parser supporting console and GitHub Actions reporter formats.
  Introduce observeLine hook for context tracking across noise-filtered lines,
  state isolation between extract calls, and test output context detection.

## 0.1.2

### Patch Changes

- 3944d8e: Sanitize JSDoc examples to use obviously fake credentials

## 0.1.1

### Patch Changes

- c18225b: Harden regex patterns against ReDoS attacks by using bounded character classes and preventing backtracking

## 0.1.0

### Minor Changes

- 50d0ad0: Initial release of the Detent parser package

  ### Features

  - **Multi-Language Error Parsing**: Extract structured errors from TypeScript, ESLint, Go, Python, Rust, and generic output
  - **GitHub Actions Context Parser**: Parse GitHub Actions logs with timestamp stripping and workflow command extraction
  - **Act Context Parser**: Parse local Act runner output with ANSI escape handling
  - **CI Event System**: Typed event stream for job start/end, step execution, and error detection
  - **Error Registry**: Central registry for discovered errors with deduplication

  ### Parsers Included

  - **TypeScript**: TSC errors with file, line, column, and error code extraction
  - **ESLint**: Lint violations with rule IDs and fix suggestions
  - **Go**: Build and test errors from `go build`, `go test`
  - **Python**: Syntax errors, tracebacks, and pytest failures
  - **Rust**: Cargo build errors with span information
  - **Infrastructure**: Generic command failures and exit codes

  ### Technical Details

  - Event-driven architecture for streaming log processing
  - Severity levels: error, warning, info
  - Code snippet extraction with context lines
  - Serialization support for persistence
  - Comprehensive test suite with real-world log samples
