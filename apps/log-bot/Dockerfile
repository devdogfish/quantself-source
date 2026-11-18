FROM oven/bun:1-alpine
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/ ./packages/
COPY apps/log-bot/ ./apps/log-bot/

RUN bun install
# Generate Prisma client (gitignored, so must be built here).
# Dummy URL: prisma generate only emits TS code, never connects to DB.
RUN cd packages/db && DATABASE_URL="postgresql://dummy:dummy@postgres:5432/dummy" bunx prisma generate

WORKDIR /app/apps/log-bot
CMD ["bun", "run", "src/index.ts"]
