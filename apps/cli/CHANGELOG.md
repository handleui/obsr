# @detent/cli

## 0.3.0

### Minor Changes

- 92ef167: Add automatic updates at CLI startup with user preference control.
  Includes CI environment detection (auto-disabled), 24-hour cache for non-blocking checks,
  lock file to prevent concurrent updates, and `autoUpdate` preference via `detent config set/get`.

## 0.2.2

### Patch Changes

- 3944d8e: Redact sensitive data (API keys, tokens) from error messages in config and init commands
- Updated dependencies [3944d8e]
  - @detent/parser@0.1.2

## 0.2.1

### Patch Changes

- c18225b: Mask API keys in init TUI to prevent accidental exposure
- Updated dependencies [c18225b]
  - @detent/parser@0.1.1

## 0.2.0

### Minor Changes

- 9b317d5: Add auth commands (login, logout, status) using OAuth 2.0 Device Authorization flow.
  Credentials are stored securely in .detent/credentials.json with automatic token refresh.

  Add organization management commands (create, list, status, members, join, leave).
  Add link commands for binding repositories to organizations (link, status, unlink).
  Add whoami command for displaying current user identity with optional debug info.
  Add centralized API client library with typed endpoints for organizations, auth, and user info.

## 0.1.0

### Minor Changes

- a5bac3a: Initial release of the Detent CLI - TypeScript rewrite from scratch

  ### Breaking Changes from Previous Go Implementation

  - Complete rewrite in TypeScript - no longer Act-first architecture
  - New `mock` command replaces integrated check behavior
  - Configuration moved to `config` subcommand

  ### Commands

  - **`detent mock`**: Run CI workflows locally with full TUI, streaming logs, and error parsing
  - **`detent config`**: Manage repository-specific and global settings
  - **`detent init`**: Initialize Detent in a repository
  - **`detent update`**: Self-update the CLI binary
  - **`detent version`**: Display version information

  ### Features

  - **Ink-based TUI**: Rich terminal interface with progress indicators, job status, and error highlighting
  - **Multi-platform Support**: Pre-built binaries for macOS (Intel/ARM), Linux (x64/ARM), and Windows
  - **Smart Error Parsing**: Integrates with `@detent/parser` for TypeScript, ESLint, Go, Python, and Rust errors
  - **GitHub Actions Compatibility**: Parse and display GitHub Actions workflow commands
  - **Signal Handling**: Graceful shutdown and cleanup on SIGINT/SIGTERM

  ### Technical Details

  - Built with `citty` for CLI argument parsing
  - React 18 + Ink 5 for terminal UI components
  - Uses workspace packages: `@detent/git`, `@detent/parser`, `@detent/persistence`, `@detent/healing`
  - Vitest for unit testing

### Patch Changes

- Updated dependencies [a5bac3a]
- Updated dependencies [50d0ad0]
- Updated dependencies [a5bac3a]
- Updated dependencies [50d0ad0]
  - @detent/persistence@0.1.0
  - @detent/git@0.1.0
  - @detent/healing@0.1.0
  - @detent/parser@0.1.0
