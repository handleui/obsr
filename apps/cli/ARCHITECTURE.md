# CLI Architecture

Command-line interface for Detent. Built with Citty for command routing and Ink for interactive TUI components.

## Command Architecture

```
dt <command> [subcommand] [args]
    |
    v
src/index.ts          Entry point, Sentry init, auto-update check
    |
    v
commands/index.ts     Main command definition (Citty)
    |
    +-- auth/         login, logout
    +-- config/       edit, get, set, list
    +-- org/          add, list, delete, leave, invite, invitations/
    +-- link/         (root), status, unlink
    +-- errors        Show CI errors for commit
    +-- whoami        Current user info
    +-- update        Manual update
    +-- version       Version info
```

**Command Definition Pattern (Citty)**

```typescript
export const exampleCommand = defineCommand({
  meta: { name: "example", description: "..." },
  args: {
    flag: { type: "boolean", default: false },
    value: { type: "string", alias: "v" },
  },
  subCommands: {
    sub: () => import("./sub.js").then((m) => m.subCommand),  // lazy-loaded
  },
  run: async ({ args }) => { /* implementation */ },
});
```

Subcommands are lazy-loaded via dynamic imports to reduce startup time.

## Authentication Flow

Two authentication methods supported:

### 1. Browser Flow (Default)

```
User runs `dt auth login`
         |
         v
    Start localhost callback server (random port)
    Generate cryptographic state token
         |
         v
    Open browser to navigator.detent.sh/cli/auth?port=PORT&state=STATE
         |
         v
    User authenticates via WorkOS (SSO/OAuth)
         |
         v
    Navigator redirects to localhost:PORT/callback?code=CODE&state=STATE
         |
         v
    Verify state, exchange code for tokens via Navigator API
         |
         v
    Save credentials to ~/.detent/credentials.json
```

**Localhost Server** (`lib/localhost-server.ts`):
- Uses port 0 for OS-assigned random available port
- Tracks sockets for fast shutdown
- 5-minute timeout
- Returns HTML success page to browser

### 2. Device Code Flow (--headless)

For environments without browser access (CI, SSH, containers):

```
User runs `dt auth login --headless`
         |
         v
    Request device authorization from WorkOS
         |
         v
    Display verification URL and user code
         |
         v
    Poll WorkOS for token completion
         |
         v
    Save credentials
```

## State Management

Three distinct storage layers:

```
~/.detent/                     # Global (DETENT_HOME)
    credentials.json           # Auth tokens (0o600)
    preferences.json           # User preferences (autoUpdate)
    update-cache.json          # Version check cache
    update.lock                # Concurrent update prevention

<repo>/.detent/                # Per-repository
    config.json                # Resolving config (apiKey, model, budgets)
    project.json               # Project link (org/project binding)
```

### Credentials (`lib/credentials.ts`)

```typescript
interface Credentials {
  access_token: string;        // WorkOS JWT
  refresh_token: string;
  expires_at: number;          // Unix timestamp (ms)
  github_token?: string;       // GitHub OAuth (from Navigator)
  github_token_expires_at?: number;
  github_refresh_token?: string;
  github_refresh_token_expires_at?: number;
}
```

- In-memory cache to avoid repeated file reads
- 5-minute expiration buffer for proactive refresh
- GitHub tokens auto-refresh via API when expired

### Config (`lib/config.ts`)

Per-repo resolving configuration:

```typescript
interface GlobalConfig {
  $schema?: string;
  apiKey?: string;             // AI Gateway API key
  model?: string;              // openai/gpt-5.2-codex
  budgetPerRunUsd?: number;    // 0-100
  budgetMonthlyUsd?: number;   // 0-1000
  timeoutMins?: number;        // 1-60
}
```

### Preferences (`lib/preferences.ts`)

Global CLI behavior settings:

```typescript
interface Preferences {
  autoUpdate: boolean;         // Default: true
}
```

### Project Config

Links repository to Detent project:

```typescript
interface ProjectConfig {
  organizationId: string;
  organizationSlug: string;
  projectId: string;
  projectHandle: string;
}
```

## Environment Detection

```
lib/env.ts
    |
    +-- isProduction()        DETENT_PRODUCTION compile-time flag
    +-- getDetentHome()       Override via DETENT_HOME, else:
                                - Production: ~/.detent
                                - Development: ~/.detent-dev
```

Development isolation prevents dev builds from affecting production credentials.

## TUI Component Patterns

Built with Ink (React for CLI) + custom patterns:

```
tui/
    render.ts          shouldUseTUI() - TTY detection
    styles.ts          Brand colors, ANSI helpers
    use-shimmer.ts     Loading animation hook
    components/
        header.tsx          Version + update banner
        org-action-flow.tsx Org selection + confirmation
```

### TUI Detection (`tui/render.ts`)

```typescript
export const shouldUseTUI = (): boolean => {
  if (process.argv.includes("--no-tui")) return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
};
```

### Color Palette (`tui/styles.ts`)

```typescript
export const colors = {
  brand: "#17DB4E",   // Electric green
  text: "#FFFFFF",    // White
  muted: "#585858",   // Gray
  error: "#FF3030",   // Red
  info: "#5B9CF5",    // Blue
  warn: "#ffaf00",    // Yellow
  success: "#00d787", // Green
};
```

### Component Example: ConfigEditor

```
commands/config/edit.tsx
    |
    +-- React component with useInput() for keyboard handling
    +-- Field navigation (up/down)
    +-- Inline editing (text, number, model cycling)
    +-- Real-time validation
    +-- Save on exit (q/esc)
```

## Git Integration

CLI uses `@detent/git` package for git operations:

```typescript
// From @detent/git
findGitRoot(cwd)          // Find repo root
getRemoteUrl(repoRoot)    // Get origin URL
getCurrentRefs(repoRoot)  // Branch, commit SHA
getCurrentBranch(repoRoot)
```

Local helper (`lib/git-utils.ts`) parses remote URLs:

```typescript
// Handles SSH and HTTPS formats
parseRemoteUrl("git@github.com:owner/repo.git")  // "owner/repo"
parseRemoteUrl("https://github.com/owner/repo")  // "owner/repo"
```

### Project Linking

```
dt link
    |
    +-- Find git root
    +-- Get remote URL
    +-- Parse to owner/repo
    +-- Lookup project via API
    +-- Save to .detent/project.json
```

## API Client

`lib/api.ts` - Typed fetch wrapper with auth:

```typescript
const response = await apiRequest<T>(path, {
  method: "POST",
  body: payload,
  accessToken,
  headers: { "X-GitHub-Token": githubToken },
});
```

**Error Classes**:
- `ApiNetworkError` - Connection failures
- `ApiAuthError` - 401 responses

**Endpoints**:
- `/v1/auth/sync-user` - Sync user identity
- `/v1/auth/me` - Current user info
- `/v1/auth/organizations` - User's organizations
- `/v1/auth/github-orgs` - GitHub orgs available for install
- `/v1/auth/github-token/refresh` - Refresh GitHub OAuth
- `/v1/projects/*` - Project CRUD
- `/v1/organization-members/*` - Member management
- `/v1/orgs/*/invitations` - Invitation management
- `/v1/errors` - CI errors for commit

## Auto-Update Mechanism

```
src/index.ts (startup)
    |
    v
maybeAutoUpdate()
    |
    +-- Skip if dev version (0.0.0)
    +-- Skip if disabled (env, CI, preference)
    +-- Skip for update/version commands
    |
    v
checkForUpdate()
    |
    +-- Use cache if < 24 hours old
    +-- Else fetch https://detent.sh/api/cli/manifest.json
    +-- Retry with exponential backoff (3 attempts)
    |
    v
If update available:
    +-- Acquire lock file (prevent concurrent updates)
    +-- Run install script (curl | bash or irm | iex)
    +-- Re-exec with new binary
```

**Disable Methods**:
1. `DETENT_NO_AUTO_UPDATE=1` env var
2. CI detection (GITHUB_ACTIONS, GITLAB_CI, etc.)
3. `dt config set autoUpdate off`

**Files**:
- `~/.detent/update-cache.json` - 24-hour version cache
- `~/.detent/update.lock` - Concurrent update prevention (5-min stale threshold)

## Build System

Standalone binaries built with Bun's compile feature:

```bash
bun build --compile --target=bun-linux-x64 \
  --define=DETENT_VERSION='"x.y.z"' \
  --define=DETENT_PRODUCTION=true \
  --define=process.env.WORKOS_CLIENT_ID='"..."' \
  --minify src/index.ts --outfile=dist/dt-linux-amd64
```

**Targets**:
- linux-amd64, linux-arm64
- darwin-amd64, darwin-arm64
- windows-amd64

**Build Artifacts**:
- `dist/dt-{os}-{arch}.tar.gz` (Unix)
- `dist/dt-{os}-{arch}.zip` (Windows)
- `dist/checksums.txt` (SHA256)

## Error Handling

### Sentry Integration (`lib/sentry.ts`)

Lazy-loaded, only in production with SENTRY_DSN set.

```typescript
// index.ts
await initSentry();

process.on("uncaughtException", async (error) => {
  captureException(error);
  await flush();
  throw error;
});
```

### Command-Level Errors

```typescript
// Pattern: explicit exit codes
try {
  const token = await getAccessToken();
} catch {
  console.error("Not logged in. Run `dt auth login` first.");
  process.exit(1);
}
```

### Project Link Validation (`lib/require-link.ts`)

```typescript
// Exits on error
const { repoRoot, config } = await requireProjectLink();

// Or handle errors manually
const result = await getProjectLink();
if (!result.ok) {
  printLinkError(result.error);
  return;
}
```

## Directory Structure

```
apps/cli/
    src/
        index.ts              Entry point
        types.ts              Shared types
        commands/             Command definitions
            index.ts          Main command tree
            auth/             Authentication
            config/           Configuration management
            link/             Project linking
            org/              Organization management
            errors.ts         CI error viewing
            update.ts         Manual update
            version.ts        Version display
            whoami.ts         User info
        lib/                  Core utilities
            api.ts            API client
            auth.ts           Token management
            browser.ts        Cross-platform browser opener
            config.ts         Config file handling
            credentials.ts    Credential storage
            env.ts            Environment detection
            git-utils.ts      Git URL parsing
            localhost-server.ts OAuth callback server
            preferences.ts    User preferences
            require-link.ts   Project link validation
            sentry.ts         Error tracking
            ui.ts             UI helpers
        tui/                  Terminal UI
            components/       Ink components
            render.ts         TTY detection
            styles.ts         Colors and formatting
            use-shimmer.ts    Loading animation
        utils/                Utilities
            auto-update.ts    Update system
            error.ts          Error helpers
            format.ts         Output formatting
            signal.ts         Signal handling
            version.ts        Version detection
    scripts/
        build-binaries.ts     Cross-platform build
        upload-binaries.ts    Release upload
    dist/                     Build output
```
