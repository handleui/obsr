---
title: Quickstart
description: Add Detent to your repo in 5 minutes
---

## 1. Add the GitHub Action

Add this to your workflow file. Put it at the end of your CI job:

```yaml
# .github/workflows/ci.yml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint -- --format json --output-file eslint-report.json
        continue-on-error: true
      - run: npm test
        continue-on-error: true

      # Add Detent at the end
      - uses: detent/action@v1
        with:
          token: ${{ secrets.DETENT_TOKEN }}
        if: always()
```

:::scalar-callout{type="warning"}
Use `if: always()` — otherwise the action won't run when your CI fails (which is exactly when you need it).
:::

## 2. Get Your Token

1. Go to [navigator.detent.sh](https://navigator.detent.sh)
2. Sign in with GitHub
3. Copy your API token
4. Add it to your repo's secrets as `DETENT_TOKEN`

## 3. Push and Break Something

Push a commit with a lint error. On purpose. Watch what happens:

1. GitHub Actions runs
2. ESLint fails
3. Detent parses the error
4. You get a PR comment with the fix

![Detent PR comment with suggested fix](/assets/pr-comment.png)

Click **Apply** and the fix is committed to your branch.

## 4. Install the CLI (Optional)

The CLI lets you view errors locally and manage your projects:

::::scalar-tabs
:::scalar-tab{ title="curl (recommended)" }
```bash
curl -fsSL https://detent.sh/install.sh | bash
```
:::

:::scalar-tab{ title="npm" }
```bash
npm install -g detent
```
:::

:::scalar-tab{ title="homebrew" }
```bash
brew install handleui/tap/detent
```
:::
::::

Then link your repo:

```bash
dt auth login
dt link
```

Now you can check errors from the command line:

```bash
dt errors
```

## Next Steps

::::scalar-row
:::scalar-card{ icon="solid/basic-magic-wand" title="How Healing Works" }
Understand the AI under the hood

[Learn More →](/cli/how-healing-works)
:::

:::scalar-card{ icon="solid/basic-wrench" title="Supported Tools" }
ESLint, TypeScript, Vitest, and more

[View Tools →](/cli/tools)
:::
::::
