# @detent/healing

## 0.4.3

### Patch Changes

- Updated dependencies [74eab1c]
- Updated dependencies [74eab1c]
- Updated dependencies [74eab1c]
  - @detent/parser@0.7.0
  - @detent/types@0.4.0
  - @detent/lore@0.2.0

## 0.4.2

### Patch Changes

- 6bfca1a: Update to use shared types from @detent/types.
- Updated dependencies [6bfca1a]
- Updated dependencies [6bfca1a]
- Updated dependencies [6bfca1a]
  - @detent/parser@0.6.0
  - @detent/types@0.3.0
  - @detent/lore@0.1.2

## 0.4.1

### Patch Changes

- 5fa4de0: Update to use shared types from @detent/types.
- Updated dependencies [5fa4de0]
- Updated dependencies [5fa4de0]
  - @detent/parser@0.5.3
  - @detent/types@0.2.0
  - @detent/lore@0.1.1

## 0.4.0

### Minor Changes

- 2c9889d: Integrate error hints from @detent/lore into healing prompts.
  Adds `formatErrorsWithHints` function that enriches error output with contextual guidance for the AI.

### Patch Changes

- 18b9db1: Add cache control to prompts for improved token efficiency and increase max retries.
  Expand eval dataset with 10 negative test cases for unfixable errors (missing files, network issues, env vars, memory limits, flaky tests, etc).
- Updated dependencies [2c9889d]
  - @detent/lore@0.1.0

## 0.3.0

### Minor Changes

- 1164f26: Add eval module with LLM-as-Judge scorers and Braintrust integration.
  Includes cost tracking, tracing utilities, live mode support, and expanded test dataset.

## 0.2.0

### Minor Changes

- 5de32e4: Migrate from Anthropic SDK to Vercel AI SDK with AI Gateway support.
  Enables multi-provider model access while maintaining BYOK capability via providerOptions.
  Simplifies agentic loop by leveraging built-in tool calling and step-based control flow.
  Fixes cache token tracking in budget calculations.

## 0.1.0

### Minor Changes

- a5bac3a: Initial release of the Detent healing module (AI-powered error correction)

  ### Features

  - **Anthropic Claude Integration**: Direct API client for Claude models
  - **Agentic Error Fixing Loop**: Autonomous iteration over errors until resolution
  - **File System Tools**: Safe read/write/edit operations for code modifications
  - **Structured Prompt System**: Modular prompt components for consistent AI behavior
  - **Evaluation Framework**: Braintrust integration for measuring fix quality

  ### Architecture

  - Utility-first design: tools and prompts are composable and testable
  - Streaming support for real-time feedback during fixes
  - Configurable model selection (Claude Sonnet, Haiku, etc.)
  - Sandboxed file operations to prevent unintended changes

  ### Technical Details

  - Built on `@anthropic-ai/sdk` for type-safe API access
  - `fast-glob` for efficient file discovery
  - Comprehensive TypeScript types for tool inputs/outputs
