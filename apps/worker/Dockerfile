# Multi-stage build for the WalletWise Worker.
# Stage 1: install workspace + build worker + contracts + config + ai + db client.
# Stage 2: minimal runtime image (production deps only + dist).
#
# The migrate container runs separately; this image NEVER runs migrations.

FROM node:22-alpine AS builder
WORKDIR /repo

RUN apk add --no-cache openssl
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ai/package.json packages/ai/
COPY infra/db/package.json infra/db/

RUN pnpm install --frozen-lockfile

COPY apps/worker apps/worker
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/ai packages/ai
COPY infra/db infra/db

RUN pnpm -C infra/db exec prisma generate
RUN pnpm -C packages/config build && \
    pnpm -C packages/contracts build && \
    pnpm -C packages/ai build && \
    pnpm -C apps/worker build

# Prune devDeps to slim the runtime image.
RUN pnpm --filter @walletwise/worker deploy --prod --legacy /out
RUN set -eux; \
    prisma_dir="$(find node_modules/.pnpm -path '*/node_modules/.prisma' -type d -print -quit)"; \
    prisma_target="$(find /out/node_modules/.pnpm -path '*/node_modules/@prisma/client' -type d -print -quit)"; \
    test -n "$prisma_dir"; \
    test -n "$prisma_target"; \
    cp -R "$prisma_dir" "$(dirname "$(dirname "$prisma_target")")/.prisma"

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /out /app

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

CMD ["node", "dist/main.js"]
