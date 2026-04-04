# Build from repository root: docker build -f apps/obsr/Dockerfile .
# Pin base images by digest in production for reproducible builds.
FROM oven/bun:1 AS builder
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
RUN bun run build --filter=@obsr/obsr

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/obsr/.next/standalone ./
COPY --from=builder /app/apps/obsr/.next/static ./apps/obsr/.next/static
COPY --from=builder /app/apps/obsr/public ./apps/obsr/public

RUN chown -R node:node /app

WORKDIR /app/apps/obsr

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=50s --retries=3 \
  CMD node -e 'require("http").get("http://127.0.0.1:"+(process.env.PORT||3000)+"/",(r)=>{r.resume();r.on("end",()=>process.exit((r.statusCode||0)<500?0:1));}).on("error",()=>process.exit(1))'

CMD ["node", "server.js"]
