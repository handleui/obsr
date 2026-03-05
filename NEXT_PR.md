# Next PR: Auth + Data + Naming Validation

## Goal
Prepare a focused follow-up PR where another agent validates whether Better Auth can realistically replace WorkOS in Detent without breaking current auth flows.

## Why This Exists
We discussed three strategic ideas:
1. Move authentication to Better Auth.
2. Validate whether the current single-database Neon model is sufficient long-term.
3. Evolve `autofix` toward a broader `action` abstraction that can later include observe + resolve steps.

This document turns those ideas into an executable validation PR scope.

## Current State (Repo Reality)
- Auth is deeply WorkOS-based today:
  - CLI device/browser auth flows and WorkOS token exchange.
  - Observer JWT verification against WorkOS JWKS + issuer.
  - WorkOS env vars and docs surface are already baked in.
- Single DB is active in production paths:
  - Neon/Drizzle owns operational, workflow, and reporting entities.
- Resolve model still includes explicit `"autofix" | "resolve"` typing.

## Recommendation Summary
- Better Auth migration: **Yes, but phased.**
- DB split decision: **Validate now; do not merge by default.**
- `autofix` rename to `action`: **Good direction, do as additive abstraction first.**

## Scope For The Next PR (Validation PR)
This PR should validate and de-risk, not hard-cut.

### 1) Better Auth Feasibility Spike (Primary)
- Produce a compatibility matrix: WorkOS feature-by-feature vs Better Auth capability.
- Verify support for required Detent flows:
  - CLI login (browser/device-like experience)
  - API bearer auth
  - machine/API key style auth coexistence
  - org/user identity mapping requirements
- Define migration architecture:
  - dual-issuer acceptance window
  - token/session format strategy
  - fallback/rollback path
- Identify unavoidable gaps and implementation cost (high/med/low).

### 2) Dual-DB Validation (Decision Input)
- Map canonical ownership per entity inside Neon schemas.
- List cross-DB write/read paths and failure modes.
- Add a short scorecard using real signals:
  - latency impact
  - operational complexity
  - consistency risk
  - developer friction
- Recommend one of:
  - keep split with guardrails, or
  - merge selected domains back.

### 3) `autofix` -> `action` Naming/Model Plan (Non-breaking)
- Propose domain model where `autofix` becomes one `action` subtype/step.
- Keep compatibility with current `ResolveType` surface in this phase.
- Define migration sequence for code + API + analytics naming.

## Explicit Non-Goals
- No production auth cutover in this PR.
- No broad DB schema migration in this PR.
- No forced rename that breaks existing `autofix` contracts.

## Deliverables
- Feasibility report with a go/no-go recommendation for Better Auth.
- Incremental migration plan (phases + rollback criteria).
- DB split decision memo with measurable criteria.
- Naming migration proposal for `action` abstraction with compatibility notes.

## Exit Criteria
- We can answer: "Can Better Auth fill WorkOS' shoes for Detent's actual requirements?" with evidence.
- We have a phased migration design with fallback.
- We have a data-backed DB split decision path.
- We have a safe evolution path from `autofix` to `action`.

## Suggested PR Title
`chore: validate better-auth feasibility, dual-db boundaries, and action abstraction`
