---
"@detent/parser": minor
---

Add detection for unsupported tools (Jest, Prettier, Playwright, Cypress, webpack, etc.).
Includes helper functions `isUnsupportedToolID` and `getUnsupportedToolDisplayName` for
identifying and displaying tools that are detected but lack dedicated parsers.
