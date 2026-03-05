# Environment Variables

The CLI handles environment variables differently in development vs production.

## Data Directory

The CLI stores data (credentials, preferences, cache, etc.) in different directories:

| Environment | Directory | Description |
|-------------|-----------|-------------|
| Development | `~/.detent-dev` | Used when running from source |
| Production | `~/.detent` | Used in compiled binaries |

This separation ensures local development doesn't interfere with production installations.

### Override

Set `DETENT_HOME` to use a custom directory:

```bash
DETENT_HOME=/path/to/custom/dir detent <command>
```

## Development

CLI auth uses Better Auth device authorization endpoints on Observer.

Create a `.env` file in `apps/cli/`:

```bash
# Optional - point to local services
DETENT_API_URL=http://localhost:8787

# Optional - custom device client id (defaults to "detent-cli")
DETENT_CLI_CLIENT_ID=detent-cli

# Optional - use custom data directory (defaults to ~/.detent-dev in dev)
# DETENT_HOME=~/.detent-custom
```

The CLI loads this file automatically via `dotenv` when running in dev mode.

## Production Binaries

**Users don't need to set anything.** All values are baked into the binary at compile time.

When building binaries (`bun run build:binaries`), the build script:

| Variable | Required? | Default |
|----------|-----------|---------|
| `DETENT_API_URL` | No | `https://observer.detent.sh` |
| `DETENT_CLI_CLIENT_ID` | No | `detent-cli` |

Example build command:

```bash
bun run build:binaries
```

The magic happens in `scripts/build-binaries.ts` - it uses Bun's `--define` flag to replace `process.env.X` references with literal strings at compile time. No runtime env lookup is needed.

## How It Works

```typescript
// src/index.ts
declare const DETENT_PRODUCTION: boolean | undefined;

if (typeof DETENT_PRODUCTION === "undefined") {
  // Dev mode: load .env file
  const { config } = await import("dotenv");
  config({ path: ".env" });
}
// Production: DETENT_PRODUCTION is true, .env is never loaded
// All process.env.X calls are already replaced with actual values
```

## CI/CD

No auth provider secret is required for CLI binary builds. Optional overrides can be set with `DETENT_API_URL` and `DETENT_CLI_CLIENT_ID`.
