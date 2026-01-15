---
"@detent/parser": patch
---

Fix false positive annotations from vitest parser when errors appear in test output context.
Add test output context tracking to prevent mock errors and console output from being annotated.
