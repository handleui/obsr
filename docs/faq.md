---
title: FAQ
description: Common questions about Detent
---

## General

### What is Detent?

Detent is an AI-powered CI tool. When your GitHub Actions fail, Detent parses the errors, writes fixes using Claude, and lets you apply them with one click.

### How is this different from Copilot?

Copilot helps you write code. Detent fixes code that's already broken — after you push, when CI fails. They complement each other.

### What languages do you support?

Any language with tooling that outputs structured errors. TypeScript, JavaScript, Go, Rust, and Python work best. See [Supported Tools](/cli/tools).

### Do I need to install the CLI?

No. Detent works entirely through GitHub Actions. The CLI is optional — it lets you view errors locally and manage projects.

## Security

### Is my code sent to AI?

Yes, but only the code needed to fix errors — typically 7 lines around each error, plus the error message. We don't send your full codebase.

### Where does my code run?

AI healing runs in isolated sandboxes. Each heal gets a fresh environment that's destroyed after. Nothing persists between heals.

### Can I self-host?

Not yet. Contact [sales@detent.sh](mailto:sales@detent.sh) for enterprise options.

### Are you SOC 2 compliant?

Yes, SOC 2 Type II. All data is encrypted at rest and in transit.

## Pricing

### How much does it cost?

You pay per successful heal. Autofix (formatting, imports) is free. AI heals cost 1-5 credits depending on complexity. See [Pricing](/pricing).

### Is there a free tier?

Yes. New accounts get 50 free credits — enough for ~30-50 heals.

### What if the fix doesn't work?

You're only charged for successful heals. If a fix fails or you reject it, no charge.

## Troubleshooting

### Why aren't my errors being detected?

Make sure your tools output JSON. Detent can't parse raw console output. See [Supported Tools](/cli/tools) for setup instructions.

### Why did my heal fail?

Complex logic bugs, missing dependencies, or architectural issues may be beyond what AI can fix. Detent flags these for human review instead of guessing.

### The action isn't running

Check that you're using `if: always()`. Without this, the action only runs when previous steps succeed — which defeats the purpose.

## Support

Still stuck? Email [support@detent.sh](mailto:support@detent.sh).
