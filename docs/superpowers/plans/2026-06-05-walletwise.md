# WalletWise Implementation Plan

**Goal:** Build a narrow, working personal-finance assistant: users sign in with SuperTokens, import transactions from CSV, and ask natural-language spending questions answered through typed tools that query Postgres and monthly rollups. Raw transaction history is never sent to the LLM.

**Architecture:** pnpm + Turbo monorepo. `apps/api` is NestJS + Fastify + Prisma for auth, chat streaming, tools, and uploads. `apps/web` is React + Vite + Tailwind + shadcn/ui. `apps/worker` is a NestJS application context with BullMQ for CSV import and rollup maintenance. Shared packages are `config`, `contracts`, and `ai`.

**Tech Stack:** Node 22, pnpm 10, Turbo, NestJS, Fastify, Prisma, Postgres 16, Redis 7, BullMQ, SuperTokens, AI SDK v6, React, Vite, Tailwind, shadcn/ui, Jest, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-05-walletwise-design.md` is the source of truth.

**MVP:** Phases 0 -> 5, then Phase 7. Receipt OCR is stretch only.

---

## Rules

- Use `User.id` as the app user id.
- Store the SuperTokens id in `User.authId`.
- User-owned tables use `userId`.
- API routes derive `userId` from the SuperTokens session.
- Never accept `userId` from the client or the LLM.
- Assistant data access goes through fixed typed tools.
- Spending means `amount < 0`; report positive totals with `abs`.

---

## Phase 0 — Monorepo & Infra

### Task 0.1: Workspace Root

Create:

- `package.json`
- `pnpm-workspace.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `.nvmrc`
- `.npmrc`

Root `package.json`:

```json
{
  "name": "@walletwise/workspace",
  "private": true,
  "packageManager": "pnpm@10.10.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "turbo run dev --filter @walletwise/api --filter @walletwise/web --filter @walletwise/worker",
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "db:up": "docker compose -f infra/compose/docker-compose.yml up -d postgres supertokens-db supertokens redis",
    "db:migrate": "pnpm -C infra/db migrate:deploy",
    "db:seed": "pnpm -C infra/db seed",
    "compose:up": "docker compose -f infra/compose/docker-compose.yml up --build",
    "compose:down": "docker compose -f infra/compose/docker-compose.yml down -v"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "typescript": "^5.5.2",
    "prettier": "^3.3.2"
  }
}
```

Workspace:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'infra/db'
```

Set `.nvmrc` to `22`. Set `.npmrc` to `auto-install-peers=true`.

`turbo.json`: copy the existing pattern from `/home/vesper/code/bugsport/turbo.json`, with `DATABASE_URL`, `REDIS_URL`, `GROQ_API_KEY`, `LOCAL_AI_BASE_URL`, and `SUPERTOKENS_CORE_URL` in `passThroughEnv`.

Verify:

```bash
corepack enable
pnpm install
pnpm -w typecheck
```

Commit:

```bash
git add -A && git commit -m "chore: scaffold pnpm+turbo monorepo root"
```

### Task 0.2: Config Package

Create `packages/config` with a zod env loader for API and worker.

Required env:

- `NODE_ENV`
- `PORT`
- `CLIENT_ORIGIN`
- `DATABASE_URL`
- `REDIS_URL`
- `SUPERTOKENS_CORE_URL`
- `SUPERTOKENS_API_KEY`
- `AI_ENV`
- `LOCAL_AI_BASE_URL`
- `GROQ_API_KEY`
- `CHAT_MODEL`
- `AI_PROVIDER`
- `AI_REASONING_EFFORT`
- `WORKER_CONCURRENCY`

Unit tests:

- valid API env parses
- missing `DATABASE_URL` throws
- `PORT` is coerced to number

Commit:

```bash
git add -A && git commit -m "feat(config): zod-validated env loader"
```

### Task 0.3: Docker Compose

Create:

- `infra/compose/docker-compose.yml`
- `infra/compose/.env.example`
- `apps/api/Dockerfile`
- `apps/worker/Dockerfile`
- `infra/compose/migrate.Dockerfile`

Services:

- `postgres`
- `supertokens-db`
- `supertokens`
- `redis`
- `migrate`
- `api`
- `worker`

Do not add extra database roles, MinIO, Loki, or Promtail.

Verify:

```bash
docker compose -f infra/compose/docker-compose.yml config
```

Commit:

```bash
git add -A && git commit -m "chore(infra): docker-compose for pg redis supertokens api worker"
```

---

## Phase 1 — Database & Seed

### Task 1.1: Prisma Schema

Create:

- `infra/db/package.json`
- `infra/db/prisma/schema.prisma`
- `infra/db/src/index.ts`

Models:

- `User`
- `Account`
- `Transaction`
- `MonthlyRollup`
- `UserFact`
- `Budget`
- `ImportJob`

Important fields:

- `User.id` is the internal app user id.
- `User.authId` is the SuperTokens id.
- Other user-owned tables have `userId`.
- `Transaction.amount`: negative spend, positive income.
- `MonthlyRollup.totalAmount`: positive spend total from `amount < 0`.

Indexes:

- `Transaction @@unique([userId, dedupeHash])`
- `Transaction @@index([userId, postedAt])`
- `Transaction @@index([userId, category, postedAt])`
- `MonthlyRollup @@id([userId, month, category])`

Generate and migrate:

```bash
cd infra/db
pnpm prisma migrate dev --name init
```

Commit:

```bash
git add -A && git commit -m "feat(db): prisma schema and init migration"
```

### Task 1.2: Dedupe Hash, Sample CSV, Seed

Create:

- `packages/contracts/src/dedupe.ts`
- `packages/contracts/src/dedupe.test.ts`
- `infra/db/sample/transactions.csv`
- `infra/db/prisma/seed.ts`

`dedupeHash` input:

```ts
{
  userId: string;
  postedAt: string;
  amount: number;
  merchantRaw: string;
}
```

Hash:

```ts
sha256(`${userId}|${postedAt}|${amount.toFixed(2)}|${merchantRaw.trim().toUpperCase()}`)
```

Tests:

- same inputs produce same hash
- different amount produces different hash
- different user produces different hash

Sample CSV:

- about 40 rows
- at least 4 months
- categories: groceries, dining, transport, subscriptions, rent, income
- include 2 duplicate rows
- include 1 missing amount row
- include 1 junk row

Seed script:

- create demo user with `authId = "seed-demo"`
- parse sample CSV
- skip invalid rows
- upsert transactions by `(userId, dedupeHash)`
- log imported/skipped counts

Commit:

```bash
git add -A && git commit -m "feat(db): sample CSV seed and dedupe hash"
```

---

## Phase 2 — API Auth

### Task 2.1: API Bootstrap

Create:

- `apps/api/package.json`
- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/prisma/prisma.service.ts`
- `apps/api/src/prisma/prisma.module.ts`
- `apps/api/jest.config.ts`

Use NestJS + Fastify. Copy the normal bootstrap pattern from `/home/vesper/code/bugsport`, including Fastify cookies and CORS.

Use normal Prisma access, and make services add `userId` to their own queries.

Commit:

```bash
git add -A && git commit -m "feat(api): nest fastify bootstrap and prisma module"
```

### Task 2.2: SuperTokens Auth

Create:

- `apps/api/src/auth/supertokens.init.ts`
- `apps/api/src/auth/auth.module.ts`
- `apps/api/src/auth/session.guard.ts`
- `apps/api/src/auth/user.decorator.ts`

Behavior:

- Email/password auth with SuperTokens.
- On sign-up, upsert `User { authId, email }`.
- `SessionGuard` verifies the session.
- Guard resolves the app `User.id` from `User.authId`.
- `@User('id')` reads the app user id from request context.

Manual verify:

```bash
pnpm db:up
pnpm -C apps/api dev
curl -i -X POST localhost:4000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"formFields":[{"id":"email","value":"a@b.com"},{"id":"password","value":"Password1"}]}'
```

Expected: signup succeeds and a `User` row exists.

Commit:

```bash
git add -A && git commit -m "feat(api): supertokens auth and user sync"
```

---

## Phase 3 — AI Layer & Web Shell

### Task 3.1: AIHelper

Create:

- `packages/ai/package.json`
- `packages/ai/src/ai.helper.ts`
- `packages/ai/src/ai.helper.test.ts`
- `packages/ai/src/index.ts`

Tasks:

- `CHAT`
- `PARSE_VISION`

Routing:

- `CHAT` dev -> local OpenAI-compatible `gpt-oss`
- `CHAT` prod -> Groq `openai/gpt-oss-120b`
- `PARSE_VISION` -> Groq multimodal model

Tests:

- dev chat uses local provider
- prod chat uses Groq gpt-oss model
- vision routes to multimodal provider

Commit:

```bash
git add -A && git commit -m "feat(ai): task-based model routing"
```

### Task 3.2: Streaming Chat Endpoint

Create:

- `apps/api/src/ai/ai.module.ts`
- `apps/api/src/ai/ai.controller.ts`
- `apps/api/src/ai/orchestrator.ts`

Behavior:

- `POST /ai/chat`
- guarded by `SessionGuard`
- reads `messages`
- calls `streamText`
- streams response to the client
- tools are wired in Phase 4

Commit:

```bash
git add -A && git commit -m "feat(api): streaming chat endpoint"
```

### Task 3.3: Web Shell

Create Vite React app in `apps/web`.

Required UI:

- sign-up/sign-in screen using SuperTokens frontend flow or simple auth calls
- CSV upload button/status area
- chat screen using `useChat`
- Vite proxy for `/auth`, `/ai`, and `/import`

Do not overbuild the UI. It only needs to prove the product loop:

```text
sign in -> import CSV -> ask finance questions
```

Commit:

```bash
git add -A && git commit -m "feat(web): auth import and chat shell"
```

---

## Phase 4 — Assistant Tools

### Task 4.1: Tool Catalog

Create:

- `apps/api/src/ai/tools/index.ts`
- `apps/api/src/ai/tools/tools.test.ts`

Tools:

- `query_spending`
- `list_transactions`
- `compare_periods` placeholder until Phase 5
- `save_user_fact`
- `get_user_facts`

Implementation rules:

- `buildTools({ prisma, userId })`
- each Prisma query includes the server-side `userId`
- `query_spending` filters `amount < 0`
- `query_spending` returns positive `total`
- `list_transactions` caps `limit` at 50
- "biggest purchase" sorts by most negative amount or absolute spend, not income
- user facts are stored with the current `userId`

Tests:

- `query_spending` includes `userId`
- `query_spending` includes `amount < 0`
- income does not offset spending
- `list_transactions` caps limit at 50
- user fact writes include `userId`

Wire tools into `/ai/chat`.

Commit:

```bash
git add -A && git commit -m "feat(api): assistant tool catalog for spending and memory"
```

---

## Phase 5 — Worker, CSV Import, Rollups

### Task 5.1: Queue & Worker Bootstrap

Create:

- `packages/contracts/src/queue.ts`
- `apps/api/src/queue/queue.module.ts`
- `apps/worker/package.json`
- `apps/worker/src/main.ts`
- `apps/worker/src/worker.module.ts`

Jobs:

```ts
export const JOBS = {
  IMPORT_CSV: 'import.csv',
  ROLLUP_REBUILD: 'rollup.rebuild',
  RECEIPT_OCR: 'receipt.ocr'
} as const;
```

`RECEIPT_OCR` exists as a contract but is stretch.

Commit:

```bash
git add -A && git commit -m "feat(worker): bullmq worker and queue contract"
```

### Task 5.2: CSV Import

Create:

- `packages/contracts/src/csv-import.ts`
- `packages/contracts/src/csv-import.test.ts`
- `apps/worker/src/processors/import-csv.processor.ts`
- API endpoints for `POST /import/csv` and `GET /import/:id`

Parser behavior:

- parse header `date,amount,merchant,category,account`
- validate date, amount, merchant
- normalize spending/income sign according to CSV values
- compute `dedupeHash`
- skip duplicates
- report missing fields and junk rows

API behavior:

- guarded route
- creates `ImportJob` with current `userId`
- queues CSV import job
- polling route fetches by both `id` and current `userId`

Worker behavior:

- inserts transactions with the job's `userId`
- `createMany({ skipDuplicates: true })`
- updates import report
- enqueues `ROLLUP_REBUILD`

Commit:

```bash
git add -A && git commit -m "feat(worker): CSV import with dedupe and import report"
```

### Task 5.3: Monthly Rollups & `compare_periods`

Create:

- `packages/contracts/src/rollups.ts`
- `packages/contracts/src/rollups.test.ts`
- `apps/worker/src/processors/rollup.processor.ts`

Rollup behavior:

- rebuild per user
- use only `Transaction.amount < 0`
- group by `date_trunc('month', postedAt)` and category
- store positive `totalAmount = sum(abs(amount))`
- upsert by `(userId, month, category)`

`compare_periods` tool:

- reads `MonthlyRollup` for current month and baseline months
- supports optional category
- returns `{ current, baseline, deltaPct }`
- does not read raw transactions

Tests:

- baseline average
- percent delta
- zero baseline returns `null` delta
- current user id is included in rollup reads

Commit:

```bash
git add -A && git commit -m "feat: monthly rollups and trend comparison tool"
```

---

## Phase 6 — Stretch Receipt OCR

Only build after MVP and README are done.

Create:

- `packages/contracts/src/receipt.ts`
- `packages/contracts/src/receipt.test.ts`
- `apps/worker/src/processors/receipt-ocr.processor.ts`
- `POST /receipt`

Behavior:

- upload image
- call multimodal model
- extract merchant, date, total, confidence
- confidence below threshold asks for confirmation
- confident result inserts a negative spending transaction
- enqueue rollup rebuild

Commit:

```bash
git add -A && git commit -m "feat: receipt OCR stretch"
```

---

## Phase 7 — README, Tests, Polish

### Task 7.1: README

Create `README.md` with:

- setup commands
- what was built
- what was skipped/stubbed
- architecture
- scale/context strategy
- model routing
- assumptions/trade-offs

Keep the README focused on the implementation that was actually built.

Commit:

```bash
git add -A && git commit -m "docs: README with setup architecture and tradeoffs"
```

### Task 7.2: Test And Typecheck

Run:

```bash
pnpm -w typecheck
pnpm -w test
```

Required green tests:

- config env loader
- dedupe hash
- AIHelper routing
- tools
- CSV import parser
- rollup math
- receipt parsing only if stretch was built

Commit fixes:

```bash
git add -A && git commit -m "test: green typecheck and unit suite"
```

---

## Self-Review Checklist

- Every user-owned read/write uses current `userId`.
- Spending queries filter `amount < 0`.
- Trend comparisons use `MonthlyRollup`.
- README is honest about skipped features.
