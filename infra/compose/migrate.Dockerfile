# Builds a one-shot container that runs `prisma migrate deploy` against
# DATABASE_URL.
#
# Lives separately from the API image so we can run it as a Job in K8s and as
# a `restart: "no"` service in compose.

FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache openssl
RUN corepack enable

# Copy what's needed for installing the db package + Prisma schema.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY infra/db/package.json infra/db/
COPY infra/db/prisma infra/db/prisma
COPY infra/db/tsconfig.json infra/db/tsconfig.json

# Install the db package's dependencies.
RUN pnpm install --filter @walletwise/db... --frozen-lockfile

WORKDIR /app/infra/db
RUN pnpm exec prisma generate

# Run migrations on startup (idempotent).
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
