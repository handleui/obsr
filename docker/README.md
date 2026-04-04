# Self-host (Docker Compose)

Default Postgres credentials in `compose.yaml` are for **local development only**. Use strong secrets and Docker secrets (or a managed database) for anything exposed beyond your machine.

Postgres is bound to **127.0.0.1:5432** on the host so migrations from the repo (`bun run db:migrate`) can reach the DB without publishing the port on all interfaces.

Run from the **repository root** (so build context includes `apps/obsr` and workspace packages).

1. Copy env: `cp .env.selfhost.example .env.selfhost` (or use `bun run dt -- create` at the repo root to scaffold `compose.yaml` and `.env.selfhost.example`).
2. Fill `.env.selfhost` (at least `BETTER_AUTH_SECRET`; set `AI_GATEWAY_API_KEY` if you use AI features).
3. Apply migrations against the DB (Postgres is exposed on `localhost:5432`):

   ```bash
   DATABASE_URL=postgresql://obsr:obsr@127.0.0.1:5432/obsr bun run db:migrate --cwd apps/obsr
   ```

   Start Postgres first (`docker compose -f docker/compose.yaml up -d db`) if the stack is not up yet.

4. Start the stack:

   ```bash
   docker compose -f docker/compose.yaml up --build
   ```

   Or: `bun run dt -- start --file docker/compose.yaml`  
   To point at a compose file outside the current directory (discouraged): `bun run dt -- start --file /path/to/compose.yaml --allow-outside`

Observer listens on [http://localhost:3000](http://localhost:3000).

The Compose file uses [`apps/obsr/Dockerfile`](../apps/obsr/Dockerfile) (Next.js `output: "standalone"`). OAuth and `BETTER_AUTH_URL` must match how you reach the app (e.g. `http://localhost:3000` for local Docker).
