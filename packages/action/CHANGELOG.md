# @detent/action

## 0.1.0

### Minor Changes

- 9b6f274: Add autofix executor that runs priority-ordered linter/formatter commands for detected errors.
  Includes command allowlist security, git patch extraction, and result reporting to API.

### Patch Changes

- c16d1b6: Add error classification for report API failures with actionable user messages.
  Errors now include categorized suggestions for auth issues, project setup, rate limits, and network problems.
