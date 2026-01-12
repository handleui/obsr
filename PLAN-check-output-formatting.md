# Plan: Improve Check Run Output Formatting

## Current State

- **Summary** (65KB max): Workflow status table - concise, good ✓
- **Text** (65KB max): Flat "Top Errors" table, only 10 errors, 80-char truncation
- **Annotations** (50 max): Inline on file lines - excellent ✓

**Problems**: Using ~2KB of 65KB. Same file repeated. Artificial limits.

## Design Principles

1. **Group by source/tool** - actionable ("10 Biome errors → run `bun run fix`")
2. **Collapsible sections** - scannable but detailed when needed
3. **Show all errors** - we have 65KB, use it
4. **Simple annotation note** - just say "X errors annotated inline" (no complex logic)
5. **Future-proof for job separation** - source grouping nests naturally under jobs

## Proposed Output

### Summary (unchanged - keep concise)
```markdown
1 workflow failed · 14 errors · 2 passed

| Workflow | Status | Errors |
|----------|--------|--------|
| CI       | Failed | 14     |
```

### Text Section (new structure)

```markdown
*14 errors annotated inline where possible*

---

### TypeScript (3 errors)

<details>
<summary>src/app.ts (2 errors)</summary>

| Line | Message |
|------|---------|
| 42   | Type 'string' is not assignable to type 'number' |
| 58   | Property 'foo' does not exist on type 'Bar' |

</details>

<details>
<summary>src/utils.ts (1 error)</summary>

| Line | Message |
|------|---------|
| 12   | Cannot find module './missing' |

</details>

---

### Biome (11 errors)

<details>
<summary>test-error.ts (10 errors)</summary>

| Line | Message |
|------|---------|
| 6    | This variable unused is unused. |
| 13   | This variable z is unused. |
| 14   | This variable arr is unused. |
| 17   | This variable obj is unused. |
| 18   | This variable fn is unused. |
| 21   | This variable tuple is unused. |
| 24   | This variable promise is unused. |
| 27   | This variable map is unused. |
| 30   | This variable set is unused. |
| 33   | This variable weakMap is unused. |

</details>

<details>
<summary>src/other.ts (1 error)</summary>

| Line | Message |
|------|---------|
| 5    | Prefer const over let |

</details>

---

`detent errors --commit 351c5fd` for full list
```

## Future: With Job Separation

Structure extends naturally:

```markdown
## Build (failed · 3 errors)

### TypeScript (3 errors)
...

---

## Lint (failed · 11 errors)

### Biome (11 errors)
...

---

## Test (passed)
```

## Implementation Steps

1. [ ] Group errors by source (typescript, biome, vitest, etc.)
2. [ ] Within each source, group by file using collapsible `<details>`
3. [ ] Remove 10-error limit (show all, or cap at ~200)
4. [ ] Remove message truncation (or increase to 500 chars)
5. [ ] Add annotation note at top: "X errors annotated inline where possible"
6. [ ] Update tests

## Decisions Made

- **Collapsible**: Yes, files collapsed by default (scannable)
- **Primary grouping**: Source/tool (actionable, future-proofs for jobs)
- **Secondary grouping**: File (natural for code review)
- **Annotation handling**: Simple note, no special logic
- **Error order**: By source, then by file (alphabetical), then by line

## Constraints

- `summary`: 65,535 chars max
- `text`: 65,535 chars max
- `annotations`: 50 max per API call
- GitHub renders markdown in both sections
