# @detent/parser

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
