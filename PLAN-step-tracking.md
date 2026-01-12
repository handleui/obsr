# Plan: GitHub Actions Step Tracking

## Problem

The raw output shows `Job: CI` with no step information. When CI fails on both `lint` and `test` steps, we can't tell users which step an error came from.

**Root cause**: The parser filters `##[group]` markers as noise before content parsers see them, losing step context.

## Current Architecture

### Log Format
GitHub Actions logs use markers for step boundaries:
```
2024-01-15T10:30:45.1234567Z ##[group]Run actions/checkout@v4
2024-01-15T10:30:46.1234567Z checking out repo...
2024-01-15T10:30:47.1234567Z ##[endgroup]
2024-01-15T10:30:48.1234567Z ##[group]Run npm run lint
2024-01-15T10:30:49.1234567Z error: unused variable 'x'
2024-01-15T10:30:50.1234567Z ##[endgroup]
```

### Current Filtering
**File**: `packages/parser/src/context/github.ts` (lines 27-37)
```typescript
const NOISE_PATTERNS: readonly RegExp[] = [
  /^::group::/,      // <-- Filters step markers!
  /^::endgroup::/,
  /^##\[/,           // <-- Filters GitHub internal markers!
];
```

### What Happens
1. `##[group]Run npm run lint` is marked as noise → skipped
2. Error on next line has no step context
3. `workflowJob` comes from webhook payload (`workflow_run.name`), not parsing
4. `workflowStep` is always `undefined`

## Solution

### Phase 1: Parse Step Markers in Context Parser

**File**: `packages/parser/src/context/github.ts`

Instead of filtering `##[group]` as noise, parse it to extract step name:

```typescript
// New regex to extract step name from group markers
// Format: ##[group]Run <step-name>
//     or: ##[group]<step-name>
const STEP_GROUP_REGEX = /^##\[group\](?:Run\s+)?(.+)$/;

class GitHubParser implements ContextParser {
  private currentStep = "";
  private currentAction = "";

  parseLine = (line: string): ParseLineResult => {
    const cleanLine = line.replace(TIMESTAMP_REGEX, "");

    // Check for step group start
    const groupMatch = cleanLine.match(STEP_GROUP_REGEX);
    if (groupMatch) {
      const stepName = groupMatch[1].trim();
      // Extract action if present (e.g., "actions/checkout@v4")
      if (stepName.includes("@")) {
        this.currentAction = stepName;
        this.currentStep = stepName.split("@")[0].split("/").pop() || stepName;
      } else {
        this.currentAction = "";
        this.currentStep = stepName;
      }
      return { ctx: { job: "", step: this.currentStep, isNoise: true }, cleanLine, skip: true };
    }

    // Check for step group end
    if (cleanLine.startsWith("##[endgroup]")) {
      // Keep context for errors that might follow immediately
      return { ctx: { job: "", step: this.currentStep, isNoise: true }, cleanLine, skip: true };
    }

    const isNoise = isNoiseLine(cleanLine);

    return {
      ctx: {
        job: "",
        step: this.currentStep,
        action: this.currentAction,
        isNoise,
      },
      cleanLine,
      skip: isNoise,
    };
  };

  // Reset state between jobs/files
  reset = () => {
    this.currentStep = "";
    this.currentAction = "";
  };
}
```

### Phase 2: Add Action Field to WorkflowContext

**File**: `packages/parser/src/types.ts`

```typescript
export interface WorkflowContext {
  readonly job?: string;
  readonly step?: string;
  readonly action?: string;  // Already exists but not populated
}

export interface LineContext {
  job: string;
  step: string;
  action?: string;  // Add this
  isNoise: boolean;
}
```

### Phase 3: Flow Context Through Extractor

**File**: `packages/parser/src/extractor.ts`

The extractor already applies context from context parsers to extracted errors. Ensure `action` is included:

```typescript
// In extractErrors() where context is applied to errors
if (ctx.step) {
  error.workflowContext = {
    ...error.workflowContext,
    step: ctx.step,
    action: ctx.action,
  };
}
```

### Phase 4: Reset Context Parser Between Jobs

**File**: `apps/api/src/services/log-extractor.ts` or `error-parser.ts`

Since the ZIP contains one file per job, we need to reset the context parser state between jobs:

```typescript
// When processing each job file from ZIP
for (const jobFile of sortedFiles) {
  contextParser.reset();  // Reset step tracking
  const errors = parseGitHubLogs(jobFile.content);
  // ...
}
```

### Phase 5: Improve Raw Details Display

**File**: `apps/api/src/services/comment-formatter.ts`

Update `generateRawDetails` to show better step info:

```typescript
// Workflow context
if (error.workflowJob || error.workflowStep) {
  sections.push("");
  sections.push("=== Workflow Context ===");
  if (error.workflowJob) {
    sections.push(`Job: ${error.workflowJob}`);
  }
  if (error.workflowStep) {
    sections.push(`Step: ${error.workflowStep}`);
  }
  if (error.workflowAction) {
    sections.push(`Action: ${error.workflowAction}`);
  }
}
```

## GitHub Log Structure Reference

### ZIP Archive
- One `.txt` file per job (named by job, sorted alphabetically)
- No metadata file with step names
- Steps are concatenated within each job file

### Step Markers in Logs
```
##[group]<title>          - Step start (title = step name or "Run <action>")
##[endgroup]              - Step end
::group::title            - User-created group (not a step)
::endgroup::              - User-created group end
```

### Common Step Patterns
```
##[group]Run actions/checkout@v4
##[group]Run npm ci
##[group]Run npm run lint
##[group]Run npm test
##[group]Post actions/checkout@v4
##[group]Set up job
##[group]Complete job
```

## Files to Modify

1. `packages/parser/src/context/github.ts` - Parse step markers instead of filtering
2. `packages/parser/src/context/types.ts` - Add action to LineContext if needed
3. `packages/parser/src/types.ts` - Ensure action field exists
4. `packages/parser/src/extractor.ts` - Flow action through to errors
5. `apps/api/src/services/error-parser.ts` - Map action field
6. `apps/api/src/services/comment-formatter.ts` - Already handles display

## Testing

### Unit Tests
1. Test step extraction from `##[group]Run npm run lint`
2. Test action extraction from `##[group]Run actions/checkout@v4`
3. Test context reset between jobs
4. Test errors within steps get correct context

### Integration Test
1. Create a workflow with multiple steps (lint, test, build)
2. Introduce errors in different steps
3. Verify annotations show correct step context

## Edge Cases

1. **Nested groups** - User-created `::group::` within steps
2. **No group markers** - Old/custom runners might not emit them
3. **Step name parsing** - Handle various formats (`Run ...`, plain name, action@version)
4. **Post-action steps** - `Post actions/checkout@v4` should be tracked

## Estimated Effort

- Phase 1-3 (parser changes): ~2-3 hours
- Phase 4 (API integration): ~1 hour
- Phase 5 (display): Already done
- Testing: ~1-2 hours
- **Total**: ~4-6 hours

## Alternative Approaches Considered

### A. Fetch Step Metadata from GitHub API
GitHub's "List jobs for a workflow run" API includes step names, but:
- Requires additional API call per workflow
- Rate limiting concerns
- Doesn't map errors to steps (still need log parsing)

### B. Parse ::error Workflow Commands
Some tools emit `::error file=...,line=...::message` which GitHub uses for annotations.
- Only works if tools emit these commands
- Most tools (TypeScript, ESLint, Biome) don't use this format
- Could be additive, not replacement

**Recommendation**: Implement Phase 1-5 (log marker parsing) as it works with all tools without API changes.
