# Detent Executor

External compute service for running autofix commands. Runs on Modal.

## Setup

1. Install Modal CLI: `pip install modal`
2. Authenticate: `modal setup` (or `python3 -m modal setup`)
   - This opens a browser for OAuth authentication with Modal
3. Create secret for API callback:
   ```bash
   modal secret create detent-api \
     API_URL=https://backend.detent.sh \
     WEBHOOK_SECRET=<generate-a-strong-secret>
   ```
   Generate the secret with: `openssl rand -base64 32`

## Deploy

```bash
modal deploy src/executor/main.py
```

## Local Test

```bash
modal run src/executor/main.py::run_autofix --data '{"repo_url": "...", "command": "biome check --write ."}'
```
