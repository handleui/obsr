# Detent CLI v1 Spec

## Summary

Detent CLI v1 is a clean-slate CLI focused on one job: expose Observer data to local users and local agents with a stable, low-friction terminal interface.

The CLI is no longer the execution engine for resolving. It is a client of Observer and related APIs.

Initial command surface:

- `dt auth`
- `dt observe`
- `dt settings`
- `dt install`

## Product Intent

The CLI should be optimized for both humans and AI agents.

For humans:

- fast startup
- clear status
- stable auth flow
- useful terminal output
- interactive flags and TUI where it helps

For agents:

- predictable exit codes
- structured output
- idempotent reads
- explicit filters
- low-noise streaming/polling
- machine-readable events

Defaults should favor humans.

Flags should unlock machine mode cleanly.

`observe` is not a resolver monitor. It is a live scope into Observer. Its job is to surface diagnostics and issue reports for a PR, branch, or CI run as they appear, so a local TUI or local LLM can consume them and act.

## Non-Goals

- Running resolution logic locally inside the CLI
- Embedding resolver orchestration into the CLI
- Replicating all current TypeScript CLI commands
- Becoming a general admin client in v1

## Design Principles

## 1. Observer-first

The CLI reads from Observer APIs and live Observer feeds. Business state lives on the server.

## 2. Minimal command surface

Small surface area beats broad coverage. Add commands only when they unlock a clear workflow.

## 3. Agent-grade contracts

Every command should be safe for automation:

- no decorative output when `--json` or `--ndjson` is requested
- stable field names
- stable error codes
- retry-safe reads
- timestamps in ISO 8601

## 4. Human mode and machine mode

The same command should support:

- interactive terminal output for humans
- structured output for agents

JSON is a first-class public interface, not a debugging afterthought.

Agent-oriented contracts should treat JSON as both an output format and, where it materially improves ergonomics, a native input format.

Guidance:

- use flags for simple scalar inputs and toggles
- support JSON input for commands with nested filters, arrays, maps, or evolving request payloads
- prefer stdin or a dedicated input flag over shell-escaped ad hoc argument packing
- do not force JSON input onto commands that are naturally simple

`dt auth` should stay flag-first in v1.

`dt observe` and future mutation commands may justify native JSON input once their request shapes become meaningfully structured.

## 5. Local-first fixing loop

The CLI exposes diagnostics. Local tools or local agents decide how to fix them.

## User Stories

- As a developer, I can authenticate once and inspect whether the CLI is connected to the right account.
- As a developer, I can watch a PR and see CI failures and review diagnostics arrive in the terminal.
- As an AI agent, I can block on `dt observe` and wait for structured issue entries to appear.
- As an AI agent, I can filter to the exact scope I care about and receive only matching diagnostics.
- As a future local TUI, I can build on top of `observe` without needing private APIs.
- As an operator, I can install or verify the GitHub App from the CLI.
- As a user, I can configure CLI behavior locally without depending on the web app.

## Command Surface

## `dt auth`

Handles authentication lifecycle.

Subcommands:

- `dt auth login`
- `dt auth logout`
- `dt auth status`

Behavior:

- `login` uses device/browser auth against Observer auth endpoints
- `logout` removes local credentials
- `status` prints current auth state and token/account metadata safe for display

Requirements:

- credentials stored locally with strict file permissions
- explicit support for non-interactive environments
- no dependence on browser-only flows

Suggested flags:

- `--json`
- `--headless`
- `--force`

`dt whoami` is not needed if `dt auth status` returns identity payload.

`auth status` should cover:

- authenticated vs unauthenticated
- current user identity
- provider linkage status
- token or session expiration when safe to display
- configured Observer base URL

## `dt observe`

Primary v1 command.

Purpose:

Observe issue reports from Observer in real time or near-real time for a selected scope.

Core scopes:

- repository
- PR
- branch
- CI run

Possible selectors:

- `--owner <owner>`
- `--repo <repo>`
- `--repo-full <owner/repo>`
- `--project <handle-or-id>`
- `--pr <number>`
- `--branch <name>`
- `--run <id>`
- `--commit <sha>`

Core modes:

- snapshot mode: fetch current matching diagnostics and exit
- watch mode: stay connected and stream updates

Suggested flags:

- `--watch`
- `--json`
- `--ndjson`
- `--since <iso8601|duration>`
- `--limit <n>`
- `--follow`
- `--poll-interval <ms>`
- `--exit-on-idle`
- `--exit-on-first-entry`
- `--type <ci|review|all>`
- `--source <ci|pr-comment|all>`
- `--severity <error|warning|all>`

### Observe Semantics

`observe` should answer one question:

"What issues does Observer currently know about for this scope, and what new ones appear while I am watching?"

It should not require users to understand internal resolve lifecycle state.

It should model Observer as a report stream. Observer gathers fixable and non-fixable findings from sources like CI diagnostics today and PR comments in the future. `observe` exposes that report stream to humans, local agents, and local TUIs.

### Observe Data Model

v1 should expose issue entries with a stable public shape. Exact field names can evolve before implementation, but the public contract should converge on something close to:

```json
{
  "id": "diag_123",
  "project_id": "proj_123",
  "scope": {
    "type": "pr",
    "pr_number": 482,
    "branch": "fix/ci",
    "commit_sha": "abc123"
  },
  "source": {
    "kind": "ci",
    "run_id": "run_123",
    "job_name": "build",
    "step_name": "typecheck"
  },
  "status": "open",
  "category": "typescript",
  "severity": "error",
  "title": "Type error",
  "message": "Property 'x' does not exist on type 'Y'",
  "file_path": "src/app.ts",
  "line": 42,
  "column": 9,
  "rule_id": "TS2339",
  "fixable": true,
  "suggested_fix_kind": "local_patch",
  "created_at": "2026-03-11T12:00:00.000Z",
  "updated_at": "2026-03-11T12:00:04.000Z"
}
```

Optional expanded fields:

- code snippet
- related files
- stack trace
- labels
- dedupe signature
- upstream comment metadata

As Observer expands beyond CI, `source.kind` should support at least:

- `ci`
- `pr_comment`

## Output Modes

## Input Modes

Flags remain the default input mode.

For commands with richer request shapes, the CLI should support native structured input in addition to flags.

Preferred patterns:

- `--input <json>`
- `--input-file <path>`
- `stdin` when the command explicitly supports piped structured data

Design rules:

- structured input should map directly to the public request contract
- flag inputs and JSON inputs must resolve to the same underlying shape
- JSON input is for complex commands, not as a blanket requirement across the CLI
- simple lifecycle commands like `auth` should avoid unnecessary structured-input ceremony

## Human Output

Default terminal output should be compact and scan-friendly:

- newest entries appended live
- stable one-entry-per-block layout
- no heavy chrome
- clear source and scope labels

Example:

```text
[ci:error] PR #482 build/typecheck src/app.ts:42:9 TS2339
Property 'x' does not exist on type 'Y'
fixable: yes
```

## JSON Output

For single-shot reads:

- emit one JSON object containing metadata and entries

For commands like `auth status`, JSON should be treated as a stable contract for agent use.

## NDJSON Output

For watch mode:

- emit one event per line
- suitable for agents, pipes, and local supervisors

Event envelope:

```json
{
  "event": "issue.upsert",
  "timestamp": "2026-03-11T12:00:04.000Z",
  "data": {
    "id": "diag_123"
  }
}
```

Suggested event types:

- `snapshot.start`
- `snapshot.end`
- `issue.upsert`
- `issue.resolved`
- `heartbeat`
- `error`

## Structured Output Policy

All commands that return state should support `--json`.

Commands that watch or stream should support `--ndjson`.

Human-oriented flags and TUI behavior should remain opt-in or default-only. Machine output must never require parsing ANSI formatting, tables, prompts, or spinners.

## Transport

Preferred transport for watch mode:

- WebSocket or SSE from Observer

Fallback:

- polling with cursor or `updated_after`

Requirements:

- reconnect support
- resumable cursors where possible
- heartbeat support
- explicit server timestamps

If live transport is not ready at launch, v1 can ship with polling first, but the public `observe` UX should already match the intended stream model.

## AI-Oriented Behavior

The CLI should be intentionally easy for agents to drive.

Requirements:

- `--json` and `--ndjson` must suppress decorative formatting
- all errors should have stable machine-readable codes
- exit code `0` for success, including empty snapshots
- non-zero only for actual failures
- repeated reads with same filters should be safe
- watch mode should be easy to block on

Agent workflow target:

1. authenticate once
2. call `dt observe --scope... --ndjson --watch`
3. wait for `issue.upsert`
4. inspect diagnostics
5. produce local fix
6. optionally continue watching

The HN discussion around AI-friendly CLIs is directionally useful here: optimize for structured, predictable outputs and avoid forcing agents to scrape decorative terminal UI. The CLI should not depend on large embedded skill systems to be usable.

Source:

- https://news.ycombinator.com/item?id=47252459

## Local State

Keep local state intentionally small.

Needed in v1:

- credentials
- optional config for API base URL and defaults
- local settings for TUI and observe defaults

Avoid per-feature local caches unless required for reliability.

## API Expectations

Observer needs a stable public contract for:

- auth login flow
- current user identity
- observe snapshot query
- observe live feed

Before implementation starts, the Observer API contract should be frozen or generated from a single source of truth. The Rust client should not depend on ad hoc TypeScript-only types.

Observer will need explicit support for repository and branch scoping, not just commit-level CI lookup, if `observe` is going to be the primary CLI primitive.

## `dt settings`

Purpose:

- manage local CLI settings
- support ratatui configuration
- avoid making the web app the only control surface

Initial subcommands:

- `dt settings get`
- `dt settings set`
- `dt settings list`
- `dt settings edit`

Suggested settings areas:

- default output mode
- default observe poll interval
- preferred live transport
- default project or repo context
- TUI preferences
- AI-oriented defaults

Settings should remain local unless there is a clear product reason to sync them remotely.

## `dt install`

Purpose:

- guide GitHub App installation from the CLI
- report installability and installation status

Initial subcommands:

- `dt install`
- `dt install status`

Expected behaviors:

- show whether the current authenticated user can install the GitHub App for candidate orgs
- show whether the app is already installed
- open or print the installation URL when installation is possible
- verify that the target owner or repo is covered by the installation

This replaces hidden dependency on older linking flows. Installation state should be a first-class concern in v1.

## Rust Implementation Direction

Suggested stack:

- `clap` for command parsing
- `reqwest` for HTTP
- `tokio` for async runtime
- `serde` and `serde_json` for contracts
- `ratatui` plus `crossterm` if an interactive TUI is added
- `tokio-tungstenite` or SSE client for live observe transport

Keep the first Rust version simple:

- no full TUI required on day one
- solid plain terminal output first
- structured streaming first-class

## Rollout Plan

## Phase 0: API Contract

- define public observe data model
- define snapshot endpoint
- define live endpoint or polling contract
- define error code contract

## Phase 1: Minimal Rust CLI

- implement `dt auth login/logout/status`
- implement `dt install` and `dt install status`
- implement `dt settings` local storage and retrieval
- implement `dt observe` snapshot mode

## Phase 2: Live Observe

- implement watch mode over WebSocket, SSE, or polling fallback
- add NDJSON event envelopes
- add reconnect and cursor semantics
- add repository, PR, branch, and run scoping parity

## Phase 3: Human UX

- improve default terminal rendering
- add optional interactive TUI if needed
- preserve machine mode as the primary contract
- make ratatui settings visible and editable from `dt settings`

## Success Criteria

- CLI startup feels instant
- local agents can consume `observe` without scraping tables
- users can scope to owner/repo, PR, branch, or run cleanly
- empty results are not treated as errors
- watch mode survives transient connection drops
- output contracts remain stable across releases
- install state is visible without needing the web UI

## Open Questions

- Should `observe` require exactly one primary scope selector, or support mixed selectors that narrow the query?
- Is live transport WebSocket, SSE, or polling in v1?
- What is the canonical public issue model: raw diagnostics, grouped issue reports, or both?
- Should `observe` stream only open issues, or lifecycle transitions too?
- Do we want a dedicated agent mode flag, or is `--ndjson` enough?
- Should project context come from local repo linkage, explicit flags, or both?
- Does `dt install` handle only GitHub App installability, or also repository coverage verification after install?
