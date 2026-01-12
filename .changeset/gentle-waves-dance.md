---
"@detent/parser": minor
---

Add step tracking to GitHub Actions context parser. The parser now extracts step names
from ##[group] markers and maintains step context across log lines, enabling errors
to be associated with their originating workflow step. Includes security measures for
input truncation and bounded regex patterns.
