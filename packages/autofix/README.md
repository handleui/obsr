# Detent Autofix

Fix lint and formatting errors before your CI checks run. Detects your tools automatically, runs fixes, and commits the result.

## Usage

Add as a step **before** your lint/test steps:

```yaml
- uses: actions/checkout@v4
- uses: detent/autofix@v1
- run: npm test
```

That's it. Autofix detects your tools, fixes what it can, and commits. Subsequent steps run on the fixed code.

## Supported tools

| Tool | Detected via |
|------|-------------|
| Biome | `biome.json` / `@biomejs/biome` in package.json |
| ESLint | `.eslintrc*` / `eslint.config.*` |
| Prettier | `.prettierrc*` / `prettier.config.js` |
| Cargo Clippy | `Cargo.toml` |
| golangci-lint | `.golangci.yml` / `.golangci.yaml` |
| `bun run fix` | `bun.lockb` + `fix` script |
| `npm run fix` | `package-lock.json` + `fix` script |

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `commit-message` | `chore: autofix lint/format issues` | Commit message for fixes |
| `auto-commit` | `true` | Set to `false` to fix files without committing |

## Outputs

| Output | Description |
|--------|-------------|
| `files-changed` | Number of files modified |
| `committed` | `true` if changes were committed and pushed |
| `tools-detected` | Comma-separated list of tools found |

## Why before checks?

```yaml
jobs:
  ci:
    steps:
      - uses: actions/checkout@v4
      - uses: detent/autofix@v1    # fixes files on disk
      - run: bun run lint           # runs on fixed code
      - run: bun run check-types
      - run: bun run test
```

Autofix and your check steps share the same filesystem. Fixes happen in-place, so everything after sees clean code. This means your CI only fails on real problems — not on issues autofix would have caught.

The commit uses GitHub's default `GITHUB_TOKEN`, so it won't trigger an infinite CI loop.

## Skip checks when autofix pushed

If you want to go further, you can skip checks entirely when autofix pushed a fix (the new commit will trigger a fresh run):

```yaml
- uses: actions/checkout@v4
- uses: detent/autofix@v1
  id: fix
- run: bun run lint
  if: steps.fix.outputs.committed != 'true'
```
