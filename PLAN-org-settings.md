# Plan: Org-Level Feature Settings

## Goal
Allow org admins to toggle features like inline annotations and PR comments per-organization.

## Database Changes

### 1. Add settings JSONB column to organizations table

**File**: `apps/api/src/db/schema.ts`

```typescript
// In organizations table definition, add after allowAutoJoin:
settings: jsonb("settings").$type<{
  enableInlineAnnotations?: boolean;  // default: true
  enablePrComments?: boolean;         // default: true
}>().default({}),
```

### 2. Generate and apply migration

```bash
cd apps/api && bun run db:generate  # Creates migration
cd apps/api && bun run db:migrate   # Applies it
```

## API Changes

### 3. Settings API routes

**File**: `apps/api/src/routes/organizations.ts`

```typescript
// GET /organizations/:id/settings
// Returns current settings (all org members can read)

// PATCH /organizations/:id/settings
// Updates settings (admin/owner only)
// Body: { enableInlineAnnotations?: boolean, enablePrComments?: boolean }
```

### 4. Webhook integration

**File**: `apps/api/src/routes/webhooks.ts`

In `handleWorkflowRunCompleted`:

```typescript
// Load org settings at start of handler
const org = await db.query.organizations.findFirst({
  where: eq(organizations.providerInstallationId, installationId),
});

const settings = org?.settings ?? {};
const enableAnnotations = settings.enableInlineAnnotations ?? true;
const enablePrComments = settings.enablePrComments ?? true;

// Later, when creating check run output:
const checkRunOutput = formatCheckRunOutput({ ... });

await github.updateCheckRun(token, {
  // ...
  output: {
    title: ...,
    summary: checkRunOutput.summary,
    text: checkRunOutput.text,
    // Only include annotations if enabled
    annotations: enableAnnotations ? checkRunOutput.annotations : undefined,
  },
});

// For PR comment:
if (prNumber && enablePrComments) {
  // ... existing PR comment logic
}
```

## Access Control

- **Read settings**: All org members
- **Write settings**: Only `owner` and `admin` roles
- Check via `organizationMembers` table `role` field

## Files to Modify

1. `apps/api/src/db/schema.ts` - Add settings column
2. `apps/api/src/routes/organizations.ts` - Add settings endpoints
3. `apps/api/src/routes/webhooks.ts` - Load and apply settings
4. `drizzle/` - Generated migration files

## Verification

1. Run migration locally: `cd apps/api && bun run db:migrate`
2. Test settings API with different roles via curl/httpie
3. Verify webhook respects settings toggle (disable annotations, trigger workflow)
4. Check that default behavior (no settings) keeps annotations enabled
