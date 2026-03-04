# Detent

[![Better Stack Badge](https://uptime.betterstack.com/status-badges/v3/monitor/2cpdx.svg)](https://uptime.betterstack.com/?utm_source=status_badge)

Self-resolving CI/CD that runs on PR's, it is very much NOT ready, please, avoid installing while I fix my mess

## Install

```bash
curl -fsSL https://detent.sh/install.sh | bash
```

Installs `dt` to `~/.local/bin`. Update with `dt update`.

## Requirements
BYOK for convenience, more providers on the way

- Anthropic API key (for `resolve` command)

## Usage

```bash
dt auth        # authenticate with GitHub
dt link        # link this repo to a Detent organization
dt config      # manage settings
dt whoami      # show current user info
dt org         # manage organizations
dt errors      # view CI errors
dt update      # update the CLI
```

## Platforms

Linux (x64, arm64) · macOS (Intel, Apple Silicon) · Windows (x64)

## Links

[Github Releases](https://github.com/handleui/detent/releases) · [Issues](https://github.com/handleui/detent/issues)

## License

MIT
