---
title: Introduction
description: AI fixes your CI before you have to
---

Your CI breaks. You dig through logs. You fix a typo. You push again. You wait.

**Detent stops the cycle.** When your build fails, Detent reads the errors, writes a fix, and opens a PR. You review, merge, done.

![Detent healing a failing CI run](/assets/healing-demo.gif)

## How It Works

::::scalar-steps
:::scalar-step{ id="step-1" title="CI fails" }
Your GitHub Action runs. ESLint, TypeScript, tests — something breaks.
:::

:::scalar-step{ id="step-2" title="Detent parses the errors" }
Our action extracts structured error data from your tools — not raw logs.
:::

:::scalar-step{ id="step-3" title="AI writes the fix" }
Claude reads your code, understands the error, and writes a patch.
:::

:::scalar-step{ id="step-4" title="You approve" }
Review the fix in a PR comment or Navigator. One click to apply.
:::
::::

## Get Started

::::scalar-row
:::scalar-card{ icon="solid/basic-add" title="Add to Your Repo" }
5 minutes to your first heal

[Get Started →](/quickstart)
:::

:::scalar-card{ icon="solid/basic-credit-card" title="See Pricing" }
Pay per fix, not per seat

[View Pricing →](/pricing)
:::
::::

## What Can Detent Fix?

- **Linting errors** — ESLint, Biome, golangci-lint
- **Type errors** — TypeScript, Flow
- **Test failures** — Vitest, Jest, Go tests
- **Build errors** — Cargo, webpack, Next.js

Not magic. Detent fixes the errors that waste your time — the typos, the missing imports, the type mismatches. The stuff that's obvious once you see it.

## Questions?

::::scalar-row
:::scalar-card{ icon="solid/basic-magic-wand" title="How Healing Works" }
The technical details

[Learn More →](/cli/how-healing-works)
:::

:::scalar-card{ icon="solid/basic-shield" title="Security & Trust" }
What Detent can access

[Read More →](/cli/trust)
:::
::::
