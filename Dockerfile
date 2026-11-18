# syntax=docker/dockerfile:1.20
# Build context is the repository root.
FROM oven/bun:1.3.14-alpine AS manifests
WORKDIR /app
COPY package.json bun.lock ./
COPY --parents ./apps/*/package.json ./packages/*/package.json ./

FROM manifests AS development-dependencies
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked bun install --frozen-lockfile

FROM manifests AS production-dependencies
RUN --mount=type=bind,source=scripts/ci/production-dependencies.ts,target=/tmp/production-dependencies.ts \
    --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    bun /tmp/production-dependencies.ts && bun install --production --frozen-lockfile

FROM development-dependencies AS prisma-client
ENV DATABASE_URL=postgresql://quantself:quantself@postgres:5432/quantself
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma/ packages/db/prisma/
RUN bun run --cwd packages/db generate

FROM prisma-client AS builder
RUN apk add --no-cache nodejs
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_BUILD_NODE_OPTIONS=--max-old-space-size=3072
ARG QUANTSELF_API_INTERNAL_URL=http://api:3001
ENV QUANTSELF_API_INTERNAL_URL=${QUANTSELF_API_INTERNAL_URL}
COPY . .
# The checked-in Prisma facade also exists in source. Use this build's generated client.
COPY --from=prisma-client /app/packages/db/generated/prisma/ packages/db/generated/prisma/
RUN bun run build:api
ARG QUANTSELF_SKIP_NEXT_TYPECHECK=0
RUN --mount=type=cache,target=/app/apps/web/.next/cache,sharing=locked \
    cd apps/web && QUANTSELF_SKIP_NEXT_TYPECHECK="$QUANTSELF_SKIP_NEXT_TYPECHECK" \
    NODE_OPTIONS="$NEXT_BUILD_NODE_OPTIONS" bun run build --webpack

FROM production-dependencies AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng poppler-utils su-exec=0.2-r3
# Fetch the frozen CLI's platform engine at build time so migrate works offline.
RUN cd packages/db && bun x --bun --no-install prisma --version
# Both inventory workers import shared API modules at runtime.
COPY --parents ./apps/api/src ./apps/web/next.config.ts ./apps/web/preview-cache.ts ./apps/web/lib ./apps/web/scripts \
    ./automation/n8n/jobs-feed/sources/sources.mjs ./packages/auth/src ./packages/budgeting ./packages/db ./scripts ./
COPY --from=prisma-client /app/packages/db/generated/prisma/ packages/db/generated/prisma/
COPY --from=builder /app/apps/web/public/ apps/web/public/
COPY --from=builder /app/apps/api/dist/ apps/api/dist/
COPY --from=builder /app/apps/web/.next/ apps/web/.next/
EXPOSE 3000 3001
CMD ["bun", "run", "--cwd", "apps/web", "start"]
