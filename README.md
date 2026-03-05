# Detent

[![Better Stack Badge](https://uptime.betterstack.com/status-badges/v3/monitor/2cpdx.svg)](https://uptime.betterstack.com/?utm_source=status_badge)

Self-resolving CI/CD platform.
Detent runs checks locally, surfaces CI failures, and helps resolve them before push.

## Install CLI

```bash
curl -fsSL https://detent.sh/install.sh | bash
```

Installs `dt` to `~/.local/bin`.

## Core Commands

```bash
dt auth         # authenticate
dt link         # link repo to org/project
dt config       # manage resolving settings
dt whoami       # show current identity
dt org          # org and member management
dt errors       # fetch CI errors for a commit
dt update       # update local CLI install
```

## Local Development URLs

- Web: `http://detent.localhost:1355`
- Observer API: `http://observer.localhost:1355`
- Resolver API: `http://resolver.localhost:1355`

## Production URLs

- App: `https://detent.sh`
- Observer API: `https://observer.detent.sh`

## Repository

- Releases: <https://github.com/handleui/detent/releases>
- Issues: <https://github.com/handleui/detent/issues>

## License

MIT
