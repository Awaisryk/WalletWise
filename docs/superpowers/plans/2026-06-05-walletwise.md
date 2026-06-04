# WalletWise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-user personal-finance assistant where users sign in, import transaction history, and ask natural-language questions answered by a tool-calling agent that aggregates in Postgres (never the prompt), with worker-maintained rollups for scale and a sandboxed read-only SQL fallback.

**Architecture:** pnpm + Turbo monorepo. `apps/api` (NestJS + Fastify + Prisma) serves auth + a streaming `/ai/chat` agent loop + tools. `apps/worker` (NestJS context + BullMQ) handles CSV import, rollup maintenance, and receipt OCR. `packages/{config,contracts,ai}` are shared. Postgres with Row-Level Security isolates tenants; the read-only SQL fallback runs under a SELECT-only role + RLS + validator.

**Tech Stack:** Node 24, pnpm 10, Turbo, NestJS, Fastify, Prisma, Postgres 16, Redis 7, BullMQ, SuperTokens, ai-sdk v6 (gpt-oss local / Groq prod), React + Vite + Zustand + Tailwind + shadcn/ui, Jest + Vitest.

**Reference repos (copy commodity patterns from these — read the cited file, adapt names to `walletwise`):**
- Infra/monorepo/queue: `/home/vesper/code/bugsport`
- AI layer/streaming/useChat: `/home/vesper/code/resume-plus`

**Spec:** `docs/superpowers/specs/2026-06-05-walletwise-design.md` — the source of truth. Do not diverge.

**Conventions for this plan:**
- "COPY FROM <path>" = read that reference file and reproduce it, renaming `bugsport`/`resume-plus` identifiers to `walletwise`. These are commodity; don't redesign them.
- Code blocks marked as full content are WalletWise-specific and must be written as shown.
- Commit after every task. Run `pnpm -w typecheck` before each commit once Phase 0 lands.
- TDD where a unit has logic (validators, parsers, rollup math, tools). Scaffolding tasks have a "verify" step instead of a test.

---

## Phase 0 — Monorepo scaffold & infra

### Task 0.1: Workspace root

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.npmrc`

- [ ] **Step 1: Root `package.json`**

```json
{
  "name": "@walletwise/workspace",
  "private": true,
  "packageManager": "pnpm@10.10.0",
  "engines": { "node": ">=24" },
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

- [ ] **Step 2: `pnpm-workspace.yaml`**

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'infra/db'
```

- [ ] **Step 3: `turbo.json`** — COPY FROM `/home/vesper/code/bugsport/turbo.json`, keep `build`/`test`/`lint`/`typecheck` cached, `dev` persistent+uncached. Ensure `passThroughEnv` includes `DATABASE_URL`, `DATABASE_URL_RO`, `REDIS_URL`, `GROQ_API_KEY`, `LOCAL_AI_BASE_URL`, `SUPERTOKENS_CORE_URL`.

- [ ] **Step 4: `tsconfig.base.json`** — COPY FROM `/home/vesper/code/bugsport/tsconfig.base.json` (strict, NodeNext, `noUncheckedIndexedAccess`, decorators).

- [ ] **Step 5: `.nvmrc`** = `24`. `.npmrc` = `auto-install-peers=true`.

- [ ] **Step 6: Verify & commit**

Run: `corepack enable && pnpm install`
Expected: lockfile created, no workspace packages yet (ok).
```bash
git add -A && git commit -m "chore: scaffold pnpm+turbo monorepo root"
```

### Task 0.2: `packages/config` (zod env)

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/env.ts`, `packages/config/src/index.ts`
- Test: `packages/config/src/env.test.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@walletwise/config",
  "version": "0.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest"
  },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "jest": "^29", "@swc/jest": "^0.2", "@types/jest": "^29" }
}
```

- [ ] **Step 2: Write failing test** `src/env.test.ts`

```ts
import { loadApiEnv } from './env';

describe('loadApiEnv', () => {
  const base = {
    NODE_ENV: 'test', PORT: '4000', CLIENT_ORIGIN: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/w',
    DATABASE_URL_RO: 'postgresql://ro:p@localhost:5432/w',
    REDIS_URL: 'redis://localhost:6379',
    SUPERTOKENS_CORE_URL: 'http://localhost:3567',
    AI_ENV: 'dev', LOCAL_AI_BASE_URL: 'http://localhost:1234/v1',
  };
  it('parses a valid env', () => {
    const env = loadApiEnv(base);
    expect(env.PORT).toBe(4000);
    expect(env.AI_ENV).toBe('dev');
  });
  it('throws on missing DATABASE_URL', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => loadApiEnv(rest)).toThrow();
  });
  it('coerces PORT to number', () => {
    expect(typeof loadApiEnv(base).PORT).toBe('number');
  });
});
```

- [ ] **Step 3: Run test, verify FAIL**

Run: `pnpm -C packages/config test`
Expected: FAIL (`loadApiEnv` not defined).

- [ ] **Step 4: Implement `src/env.ts`**

```ts
import { z } from 'zod';

const base = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_RO: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SUPERTOKENS_CORE_URL: z.string().url(),
  SUPERTOKENS_API_KEY: z.string().optional(),
  AI_ENV: z.enum(['dev', 'prod']).default('dev'),
  LOCAL_AI_BASE_URL: z.string().url().optional(),
  GROQ_API_KEY: z.string().optional(),
  CHAT_MODEL: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_REASONING_EFFORT: z.enum(['low', 'medium', 'high']).optional(),
});

const apiSchema = base;
const workerSchema = base.extend({
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

export type ApiEnv = z.infer<typeof apiSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;

export function loadApiEnv(src: NodeJS.ProcessEnv | Record<string, unknown> = process.env): ApiEnv {
  return apiSchema.parse(src);
}
export function loadWorkerEnv(src: NodeJS.ProcessEnv | Record<string, unknown> = process.env): WorkerEnv {
  return workerSchema.parse(src);
}
```

`src/index.ts`: `export * from './env';`

- [ ] **Step 5: Run test, verify PASS**

Run: `pnpm -C packages/config test`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(config): zod-validated env loader for api+worker"
```

### Task 0.3: Docker compose + Dockerfiles

**Files:**
- Create: `infra/compose/docker-compose.yml`, `infra/compose/.env.example`, `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `infra/compose/migrate.Dockerfile`

- [ ] **Step 1: `docker-compose.yml`** — COPY FROM `/home/vesper/code/bugsport/infra/compose/docker-compose.yml`, then REMOVE the `minio`, `minio-init`, `loki`, `promtail` services. Keep `postgres`, `supertokens-db`, `supertokens`, `redis`, `migrate`, `api`, `worker`. Rename DB/user to `walletwise`.

- [ ] **Step 2: Add the read-only role.** In the `postgres` service, mount an init script `infra/compose/initdb/01-readonly-role.sql`:

```sql
-- runs once on first postgres init
CREATE ROLE walletwise_ro LOGIN PASSWORD 'walletwise_ro';
GRANT CONNECT ON DATABASE walletwise TO walletwise_ro;
GRANT USAGE ON SCHEMA public TO walletwise_ro;
-- default privileges so future tables are SELECT-only for the RO role
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO walletwise_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO walletwise_ro;
```
Mount via `volumes: - ./initdb:/docker-entrypoint-initdb.d:ro` on `postgres`.

- [ ] **Step 3: Dockerfiles** — COPY `apps/api/Dockerfile` and `apps/worker/Dockerfile` and `infra/compose/migrate.Dockerfile` FROM the bugsport equivalents; adjust workspace filter names to `@walletwise/*` and the build list to `api`/`worker` + `config`/`contracts`/`ai` + `infra/db`.

- [ ] **Step 4: `.env.example`** — list every var from spec §13 with placeholder values, plus `DATABASE_URL_RO=postgresql://walletwise_ro:walletwise_ro@postgres:5432/walletwise?schema=public`.

- [ ] **Step 5: Verify**

Run: `docker compose -f infra/compose/docker-compose.yml config`
Expected: valid config, prints merged compose (no error).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(infra): docker-compose (pg+redis+supertokens) + readonly role + dockerfiles"
```

---

## Phase 1 — Database, Prisma, RLS, seed

### Task 1.1: Prisma schema + client

**Files:**
- Create: `infra/db/package.json`, `infra/db/prisma/schema.prisma`, `infra/db/src/index.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@walletwise/db",
  "version": "0.0.0",
  "main": "src/index.ts",
  "scripts": {
    "generate": "prisma generate",
    "migrate:dev": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy",
    "seed": "tsx prisma/seed.ts"
  },
  "dependencies": { "@prisma/client": "^5.20.0" },
  "devDependencies": { "prisma": "^5.20.0", "tsx": "^4", "@walletwise/config": "workspace:*" }
}
```

- [ ] **Step 2: `schema.prisma`** — write the full model from spec §4 (User, Account, Transaction, MonthlyRollup, UserFact, Budget, ImportJob), datasource `postgresql` `env("DATABASE_URL")`, generator `prisma-client-js`. Use `@@unique([userId, dedupeHash])` and the two indexes on Transaction.

- [ ] **Step 3: Generate + first migration**

Run: `cd infra/db && pnpm prisma migrate dev --name init`
Expected: migration created, client generated.

- [ ] **Step 4: `src/index.ts`** — re-export the generated client:
```ts
export * from '@prisma/client';
export { PrismaClient } from '@prisma/client';
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): prisma schema + init migration"
```

### Task 1.2: RLS policies migration

**Files:**
- Create: `infra/db/prisma/migrations/<ts>_rls/migration.sql` (hand-authored)

- [ ] **Step 1: Create an empty migration**

Run: `cd infra/db && pnpm prisma migrate dev --create-only --name rls`

- [ ] **Step 2: Fill `migration.sql`** with RLS for each tenant table. Pattern (repeat for `transactions`, `accounts`, `monthly_rollups`, `user_facts`, `budgets`, `import_jobs` — use the actual table names Prisma generated, check `schema.prisma` `@@map` or default):

```sql
ALTER TABLE "Transaction" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Transaction" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Transaction"
  USING ("userId" = current_setting('app.current_user_id', true)::uuid);
-- repeat ALTER+CREATE POLICY for each tenant table
```
> Note: `FORCE ROW LEVEL SECURITY` makes the policy apply even to the table owner used by migrations is NOT desired — instead rely on the app/RO roles being non-owners. Use `FORCE` only if the app role owns the table. Confirm which role Prisma connects as; the app must be subject to RLS, the migration role must bypass it. Document the chosen arrangement in a comment at the top of the migration.

- [ ] **Step 3: Grant SELECT on new tables to RO role (idempotent, since tables now exist):**

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO walletwise_ro;
```

- [ ] **Step 4: Apply**

Run: `cd infra/db && pnpm prisma migrate dev`
Expected: rls migration applied.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): row-level security policies for tenant isolation"
```

### Task 1.3: Sample CSV + seed script + dedupe hash

**Files:**
- Create: `infra/db/prisma/seed.ts`, `infra/db/sample/transactions.csv`
- Create: `packages/contracts/src/dedupe.ts`, `packages/contracts/src/dedupe.test.ts` (dedupe lives in contracts so api+worker+seed share it)

- [ ] **Step 1: `packages/contracts` package.json** (if not yet created)

```json
{
  "name": "@walletwise/contracts",
  "version": "0.0.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc --noEmit", "test": "jest" },
  "dependencies": { "zod": "^3.23.8" },
  "devDependencies": { "jest": "^29", "@swc/jest": "^0.2", "@types/jest": "^29", "@types/node": "^22" }
}
```

- [ ] **Step 2: Write failing test** `src/dedupe.test.ts`

```ts
import { dedupeHash } from './dedupe';

describe('dedupeHash', () => {
  it('is stable for the same inputs', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    expect(a).toBe(b);
  });
  it('differs when amount differs', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -13.0, merchantRaw: 'TESCO' });
    expect(a).not.toBe(b);
  });
  it('is scoped per user', () => {
    const a = dedupeHash({ userId: 'u1', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    const b = dedupeHash({ userId: 'u2', postedAt: '2026-03-01', amount: -12.5, merchantRaw: 'TESCO' });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `pnpm -C packages/contracts test`
Expected: FAIL (`dedupeHash` not defined).

- [ ] **Step 4: Implement `src/dedupe.ts`**

```ts
import { createHash } from 'node:crypto';

export interface DedupeInput {
  userId: string;
  postedAt: string; // ISO date
  amount: number;
  merchantRaw: string;
}

export function dedupeHash(i: DedupeInput): string {
  const norm = `${i.userId}|${i.postedAt}|${i.amount.toFixed(2)}|${i.merchantRaw.trim().toUpperCase()}`;
  return createHash('sha256').update(norm).digest('hex');
}
```
Add to `src/index.ts`: `export * from './dedupe';`

- [ ] **Step 5: Run, verify PASS**

Run: `pnpm -C packages/contracts test`
Expected: PASS (3 tests).

- [ ] **Step 6: Sample CSV** — create `infra/db/sample/transactions.csv` with ~40 rows spanning 4+ months across categories (groceries, dining, transport, subscriptions, rent, income), INCLUDING 2 exact duplicate rows, 1 row with a missing amount, and 1 junk row. Header: `date,amount,merchant,category,account`.

- [ ] **Step 7: `seed.ts`** — create a demo user (authId `seed-demo`), parse the CSV, apply `dedupeHash`, upsert transactions on `(userId, dedupeHash)`, skip rows with missing required fields. Log imported/skipped counts.

- [ ] **Step 8: Run seed against local DB**

Run: `pnpm -C infra/compose ... db:up` then `pnpm db:migrate && pnpm db:seed`
Expected: log shows imported < total (dupes + junk skipped).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(db): dedupe hash, sample CSV, seed script"
```

---

## Phase 2 — Auth (SuperTokens) + multi-user

### Task 2.1: NestJS api bootstrap + Prisma module + RLS middleware

**Files:**
- Create: `apps/api/package.json`, `apps/api/src/main.ts`, `apps/api/src/app.module.ts`, `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/prisma.module.ts`, `apps/api/jest.config.ts`

- [ ] **Step 1: `package.json`** — deps: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify`, `@walletwise/config`, `@walletwise/db`, `@walletwise/contracts`, `@walletwise/ai`, `supertokens-node`, `ai`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`, `zod`. Dev: `jest`, `@swc/jest`, `@types/*`. Scripts: `dev` (`nest start --watch` or `tsx watch src/main.ts`), `build`, `test`, `typecheck`.

- [ ] **Step 2: `main.ts`** — COPY the Fastify bootstrap pattern FROM `/home/vesper/code/bugsport/apps/api/src/main.ts` (FastifyAdapter, `@fastify/cookie`, `@fastify/cors`, supertokens fastify plugin, init SuperTokens BEFORE `NestFactory.create`). Adjust to walletwise config.

- [ ] **Step 3: `prisma.service.ts`** — COPY FROM bugsport `apps/api/src/prisma/prisma.service.ts`.

- [ ] **Step 4: RLS-scoped query helper.** Add to `PrismaService`:

```ts
/** Runs fn inside a transaction with app.current_user_id set, so RLS applies. */
async withUser<T>(userId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return this.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.current_user_id = '${userId}'`);
    return fn(tx);
  });
}
```
> `userId` is a server-controlled UUID (from the session), never user input — safe to interpolate. Add a guard that throws if `userId` is not a valid UUID before interpolation.

- [ ] **Step 5: Verify build**

Run: `pnpm -C apps/api build`
Expected: compiles.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): nest+fastify bootstrap, prisma module, RLS withUser helper"
```

### Task 2.2: SuperTokens init + user sync + auth guard

**Files:**
- Create: `apps/api/src/auth/supertokens.init.ts`, `apps/api/src/auth/auth.module.ts`, `apps/api/src/auth/session.guard.ts`, `apps/api/src/auth/user.decorator.ts`

- [ ] **Step 1: `supertokens.init.ts`** — COPY FROM bugsport `apps/api/src/auth/supertokens.init.ts`. EmailPassword + Session recipes, Fastify framework, base path `/auth`. In `signUpPOST` override, upsert a `User` row (`authId` = supertokens userId, `email`). Use the table-owner Prisma client (bypasses RLS) for this upsert.

- [ ] **Step 2: `session.guard.ts`** — Nest guard wrapping `verifySession()`; attaches `userId` (the walletwise User.id, looked up by authId) to the request.

- [ ] **Step 3: `user.decorator.ts`** — `@User('id')` param decorator reading from request.

- [ ] **Step 4: Wire into `app.module.ts`** — import `AuthModule`, `PrismaModule`, config.

- [ ] **Step 5: Manual verify**

Run: `pnpm db:up && pnpm -C apps/api dev`, then `curl -i -X POST localhost:4000/auth/signup -H 'content-type: application/json' -d '{"formFields":[{"id":"email","value":"a@b.com"},{"id":"password","value":"Password1"}]}'`
Expected: 200 + session cookies; a `User` row exists.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): supertokens auth, user sync, session guard"
```

---

## Phase 3 — AI layer + streaming chat + web shell

### Task 3.1: `packages/ai` — AIHelper port

**Files:**
- Create: `packages/ai/package.json`, `packages/ai/src/ai.helper.ts`, `packages/ai/src/index.ts`
- Test: `packages/ai/src/ai.helper.test.ts`

- [ ] **Step 1: `package.json`** — deps `ai@^6`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`, `@walletwise/config`. Dev: jest, @swc/jest.

- [ ] **Step 2: Write failing test** `src/ai.helper.test.ts`

```ts
import { AIHelper, AITask } from './ai.helper';

describe('AIHelper model selection', () => {
  it('CHAT dev uses local provider', () => {
    const c = AIHelper.getModelConfig(AITask.CHAT, 'dev');
    expect(c.provider).toBe('local');
  });
  it('CHAT prod uses groq gpt-oss-120b', () => {
    const c = AIHelper.getModelConfig(AITask.CHAT, 'prod');
    expect(c.provider).toBe('groq');
    expect(c.model).toContain('gpt-oss-120b');
  });
  it('PARSE_VISION routes to a multimodal groq model in both envs', () => {
    expect(AIHelper.getModelConfig(AITask.PARSE_VISION, 'dev').model).toContain('scout');
    expect(AIHelper.getModelConfig(AITask.PARSE_VISION, 'prod').model).toContain('scout');
  });
});
```

- [ ] **Step 3: Run, verify FAIL**

Run: `pnpm -C packages/ai test` → FAIL.

- [ ] **Step 4: Implement `ai.helper.ts`** — port the structure from resume-plus `ai.helper.ts` but minimal:

```ts
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export enum AITask { CHAT = 'chat', PARSE_VISION = 'parse_vision' }
export type AIProvider = 'local' | 'groq';
export interface ModelConfig { provider: AIProvider; model: string; temperature: number; }

const MAP: Record<AITask, { dev: ModelConfig; prod: ModelConfig }> = {
  [AITask.CHAT]: {
    dev:  { provider: 'local', model: 'gpt-oss', temperature: 0.3 },
    prod: { provider: 'groq',  model: 'openai/gpt-oss-120b', temperature: 0.3 },
  },
  [AITask.PARSE_VISION]: {
    dev:  { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', temperature: 0.1 },
    prod: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', temperature: 0.1 },
  },
};

export class AIHelper {
  static getModelConfig(task: AITask, env: 'dev' | 'prod'): ModelConfig {
    return MAP[task][env];
  }
  static getModel(task: AITask, env: 'dev' | 'prod', cfg: { GROQ_API_KEY?: string; LOCAL_AI_BASE_URL?: string }) {
    const c = this.getModelConfig(task, env);
    if (c.provider === 'groq') return createGroq({ apiKey: cfg.GROQ_API_KEY })(c.model);
    return createOpenAICompatible({ name: 'local', baseURL: cfg.LOCAL_AI_BASE_URL! })(c.model);
  }
  static getTemperature(task: AITask, env: 'dev' | 'prod') { return this.getModelConfig(task, env).temperature; }
  static getProviderOptions(task: AITask, env: 'dev' | 'prod') {
    const c = this.getModelConfig(task, env);
    if (c.provider === 'groq' && c.model.includes('gpt-oss')) {
      return { groq: { reasoningEffort: 'low' as const } };
    }
    return undefined;
  }
}
```
`index.ts`: `export * from './ai.helper';`

- [ ] **Step 5: Run, verify PASS** → `pnpm -C packages/ai test` PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(ai): AIHelper task->provider model routing (gpt-oss local / groq prod)"
```

### Task 3.2: `/ai/chat` streaming endpoint (no tools yet)

**Files:**
- Create: `apps/api/src/ai/ai.module.ts`, `apps/api/src/ai/ai.controller.ts`, `apps/api/src/ai/orchestrator.ts`

- [ ] **Step 1: `orchestrator.ts`** — builds the system prompt + runs `streamText`:

```ts
import { streamText, stepCountIs, type ModelMessage } from 'ai';
import { AIHelper, AITask } from '@walletwise/ai';

export function runChat(opts: {
  env: 'dev' | 'prod'; cfg: any; messages: ModelMessage[]; system: string; tools?: any;
}) {
  return streamText({
    model: AIHelper.getModel(AITask.CHAT, opts.env, opts.cfg),
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: stepCountIs(6),
    temperature: AIHelper.getTemperature(AITask.CHAT, opts.env),
    providerOptions: AIHelper.getProviderOptions(AITask.CHAT, opts.env),
  });
}
```

- [ ] **Step 2: `ai.controller.ts`** — `@Post('chat')` guarded by `SessionGuard`; reads `{ messages }` from body; system prompt = base instructions (tools added in Phase 4); pipe to response with `pipeUIMessageStreamToResponse`. COPY the streaming-to-Fastify-response wiring FROM resume-plus `apps/server/src/ai/ai.controller.ts`.

- [ ] **Step 3: Manual verify** — sign in, `curl` the chat endpoint with a simple message, confirm a streamed text response (requires `LOCAL_AI_BASE_URL` reachable, or set `AI_ENV=prod` + `GROQ_API_KEY`).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(api): streaming /ai/chat endpoint via AIHelper"
```

### Task 3.3: Web shell — Vite + Tailwind + shadcn + useChat

**Files:**
- Create: `apps/web/*` (Vite React TS scaffold), `apps/web/src/store/chat.store.ts`, `apps/web/src/pages/Chat.tsx`, shadcn config

- [ ] **Step 1: Scaffold** — `pnpm create vite apps/web --template react-ts` (or hand-write). Add Tailwind (`tailwind.config.js` content globs), `@ai-sdk/react`, `ai`, `zustand`. COPY the Tailwind theme tokens FROM resume-plus `tailwind.config.js`.

- [ ] **Step 2: shadcn** — `pnpm dlx shadcn@latest init`, add `button`, `card`, `input`, `scroll-area`. Confirm `components.json` + `src/components/ui/*`.

- [ ] **Step 3: `chat.store.ts`** — Zustand store holding `conversationId`, `costInfo`, UI flags.

- [ ] **Step 4: `Chat.tsx`** — `useChat({ transport: new DefaultChatTransport({ api: '/ai/chat' }) })`; render messages + a prompt input using shadcn components. COPY the useChat + `onData` (data-cost transient) pattern FROM resume-plus `coach-chat.tsx`, trimmed.

- [ ] **Step 5: Vite proxy** — `vite.config.ts` proxy `/ai` and `/auth` → `http://localhost:4000`. Add Vitest config (happy-dom) COPIED from bugsport `apps/web/vite.config.ts`.

- [ ] **Step 6: Manual verify** — `pnpm dev`, open the app, send a message, see streamed reply.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): vite+tailwind+shadcn chat shell with useChat streaming"
```

---

## Phase 4 — Tools + safe read-only SQL fallback

### Task 4.1: The SQL validator (security-critical, TDD first)

**Files:**
- Create: `apps/api/src/ai/tools/sql-validator.ts`
- Test: `apps/api/src/ai/tools/sql-validator.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { validateReadonlySql } from './sql-validator';

describe('validateReadonlySql', () => {
  it('accepts a simple SELECT', () => {
    expect(validateReadonlySql('SELECT category, SUM(amount) FROM "Transaction" GROUP BY category').ok).toBe(true);
  });
  it('accepts a leading CTE', () => {
    expect(validateReadonlySql('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(true);
  });
  it('rejects multiple statements', () => {
    expect(validateReadonlySql('SELECT 1; DROP TABLE "Transaction"').ok).toBe(false);
  });
  it('rejects writes', () => {
    for (const q of ['DELETE FROM "Transaction"', 'UPDATE "Transaction" SET amount=0', 'INSERT INTO "Transaction" VALUES (1)', 'DROP TABLE x', 'ALTER TABLE x ADD c int']) {
      expect(validateReadonlySql(q).ok).toBe(false);
    }
  });
  it('rejects system catalog access', () => {
    expect(validateReadonlySql('SELECT * FROM pg_catalog.pg_user').ok).toBe(false);
    expect(validateReadonlySql('SELECT * FROM information_schema.tables').ok).toBe(false);
  });
  it('rejects comment-hidden payloads', () => {
    expect(validateReadonlySql('SELECT 1 -- ; DROP TABLE x').ok).toBe(true); // comment stripped, still single select
    expect(validateReadonlySql('SELECT 1 /* */ ; DELETE FROM x').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL** → `pnpm -C apps/api test sql-validator` FAIL.

- [ ] **Step 3: Implement `sql-validator.ts`**

```ts
export interface ValidationResult { ok: boolean; reason?: string; }

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|do|vacuum|analyze)\b/i;
const SYSTEM = /\b(pg_catalog|information_schema|pg_[a-z_]+)\b/i;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

export function validateReadonlySql(raw: string): ValidationResult {
  const sql = stripComments(raw).trim();
  if (!sql) return { ok: false, reason: 'empty' };
  // single statement only: at most one trailing semicolon
  const withoutTrailing = sql.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) return { ok: false, reason: 'multiple statements' };
  if (!/^(select|with)\b/i.test(withoutTrailing)) return { ok: false, reason: 'must start with SELECT/WITH' };
  if (FORBIDDEN.test(withoutTrailing)) return { ok: false, reason: 'write keyword' };
  if (SYSTEM.test(withoutTrailing)) return { ok: false, reason: 'system catalog' };
  return { ok: true };
}
```

- [ ] **Step 4: Run, verify PASS** → all validator tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): read-only SQL validator with injection-attempt tests"
```

### Task 4.2: Read-only SQL executor

**Files:**
- Create: `apps/api/src/ai/tools/readonly-sql.service.ts`

- [ ] **Step 1: Implement** — a dedicated `PrismaClient` (or `pg` Pool) using `DATABASE_URL_RO`. Method `run(userId, sql)`:
  1. `validateReadonlySql(sql)` → throw on `!ok`.
  2. Open a transaction; `SET LOCAL statement_timeout = 3000`; `SET LOCAL app.current_user_id = '<userId>'` (UUID-guarded).
  3. Append `LIMIT 200` if no `limit` present (case-insensitive check).
  4. Execute via `$queryRawUnsafe`, cap returned rows to 200, return rows.

- [ ] **Step 2: Manual verify** — call with a SELECT as user A; confirm it returns only A's rows even with `WHERE userId = '<B>'` (RLS strips them).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(api): sandboxed read-only SQL executor (RO role + RLS + timeout + limit)"
```

### Task 4.3: Tool catalog + wire into chat

**Files:**
- Create: `apps/api/src/ai/tools/index.ts` (query_spending, list_transactions, compare_periods placeholder, save_user_fact, get_user_facts, run_readonly_sql)
- Test: `apps/api/src/ai/tools/tools.test.ts`

- [ ] **Step 1: Write failing tests** for `query_spending` and `list_transactions` against a mocked `PrismaService.withUser` (assert SUM aggregation shape and that limit is capped at 50).

```ts
import { buildTools } from './index';

const fakePrisma = {
  withUser: jest.fn(async (_u: string, fn: any) => fn({
    transaction: { aggregate: async () => ({ _sum: { amount: -42.5 }, _count: 3 }),
                   findMany: async () => [{ id: 't1', amount: -10, merchantRaw: 'X', postedAt: new Date(), category: 'groceries' }] },
  })),
};

describe('query_spending tool', () => {
  it('returns absolute total and count', async () => {
    const tools = buildTools({ prisma: fakePrisma as any, userId: 'u1', sql: {} as any });
    const r = await tools.query_spending.execute({ from: '2026-03-01', to: '2026-04-01', category: 'groceries' }, {} as any);
    expect(r.total).toBe(42.5);
    expect(r.txnCount).toBe(3);
  });
});

describe('list_transactions tool', () => {
  it('caps limit at 50', async () => {
    const tools = buildTools({ prisma: fakePrisma as any, userId: 'u1', sql: {} as any });
    const r = await tools.list_transactions.execute({ from: '2026-03-01', to: '2026-04-01', limit: 999, sort: 'amount_desc' }, {} as any);
    expect(r.length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `index.ts`** — `buildTools({ prisma, userId, sql, env, cfg })` returns ai-sdk `tool()` definitions with zod input schemas. Each data tool calls `prisma.withUser(userId, tx => …)`. `query_spending` → `tx.transaction.aggregate({ _sum: { amount }, _count: true, where })`, return `{ total: Math.abs(Number(sum)||0), txnCount, currency: 'USD' }`. `list_transactions` → `findMany` with `take: Math.min(input.limit ?? 20, 50)`, mapped. `save_user_fact`/`get_user_facts` → UserFact CRUD. `run_readonly_sql` → `sql.run(userId, input.sql)`. `compare_periods` → stub returning `{ note: 'implemented in Phase 5' }` (replaced in 5.3).

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Wire tools + facts into orchestrator** — load user facts (`get_user_facts`) and prepend to system prompt; pass `buildTools(...)` to `runChat`. Update `ai.controller.ts` to construct tools per request with the session `userId`.

- [ ] **Step 6: Manual verify** — ask "how much did I spend on groceries last month?" → correct number from seeded data.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(api): agent tool catalog (spending, list, facts, readonly-sql) wired into chat"
```

---

## Phase 5 — Worker, queue, CSV import, rollups

### Task 5.1: Worker bootstrap + BullMQ + queue contract

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/src/main.ts`, `apps/worker/src/worker.module.ts`
- Create: `packages/contracts/src/queue.ts` (queue name + payload types)
- Create: `apps/api/src/queue/queue.module.ts` (producer / dispatch)

- [ ] **Step 1: `packages/contracts/src/queue.ts`**

```ts
export const WALLETWISE_QUEUE = 'walletwise';
export const JOBS = { IMPORT_CSV: 'import.csv', RECEIPT_OCR: 'receipt.ocr', ROLLUP_REBUILD: 'rollup.rebuild' } as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];
export interface ImportCsvPayload { userId: string; importJobId: string; csv: string; }
export interface ReceiptOcrPayload { userId: string; imageBase64: string; mimeType: string; }
export interface RollupRebuildPayload { userId: string; month?: string; }
```

- [ ] **Step 2: API producer** — COPY the `IntegrationEventBus` + `INTEGRATION_QUEUE` provider pattern FROM bugsport `apps/api/src/issues/integration-event.bus.ts`, renamed to `JobBus` / `WALLETWISE_QUEUE`. `enqueue(name, payload, opts)` with `attempts: 3, backoff exponential`.

- [ ] **Step 3: Worker bootstrap** — COPY `apps/worker/src/main.ts` (createApplicationContext) and the manual `Worker` instantiation + dispatch table pattern FROM bugsport `apps/worker/src/integrations/integration-events.processor.ts`. Dispatch table maps `JOBS.*` → processor methods (added in 5.2/5.3/Phase 6).

- [ ] **Step 4: Verify build** → `pnpm -C apps/worker build` compiles (processors can be stubs returning void).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): bullmq worker bootstrap + dispatch table + queue contract"
```

### Task 5.2: CSV import processor (TDD on the pure parser)

**Files:**
- Create: `packages/contracts/src/csv-import.ts` (pure parse+classify), `apps/worker/src/processors/import-csv.processor.ts`
- Test: `packages/contracts/src/csv-import.test.ts`

- [ ] **Step 1: Write failing test** — given a CSV string with a duplicate, a missing-amount row, and a junk row, `parseTransactions(csv, userId)` returns `{ rows, skipped }` where valid rows are parsed, dupes collapse by `dedupeHash`, and bad rows are counted with reasons.

```ts
import { parseTransactions } from './csv-import';

const csv = `date,amount,merchant,category,account
2026-03-01,-12.50,Tesco,groceries,checking
2026-03-01,-12.50,Tesco,groceries,checking
2026-03-02,,Shell,transport,checking
junk junk junk
2026-03-03,-5.00,Cafe,dining,checking`;

it('dedupes, skips missing-amount and junk rows', () => {
  const { rows, skipped } = parseTransactions(csv, 'u1');
  expect(rows).toHaveLength(2);           // Tesco(once) + Cafe
  expect(skipped.length).toBe(3);         // 1 dup + missing amount + junk
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `csv-import.ts`** — split lines, parse header, for each row: validate date+amount+merchant; coerce amount to number; compute `dedupeHash`; track seen hashes to drop dupes; push reasons (`duplicate`/`missing_field`/`malformed`) to `skipped`.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: `import-csv.processor.ts`** — uses `parseTransactions`, bulk `createMany` (skipDuplicates), updates `ImportJob` status + report, then enqueues `ROLLUP_REBUILD` for the user. Insert under the table-owner client (writes), scoped explicitly by `userId`.

- [ ] **Step 6: API upload endpoint** — `@Post('import/csv')` (guarded): create `ImportJob`, enqueue `IMPORT_CSV`, return jobId. Add a `GET import/:id` to poll status.

- [ ] **Step 7: Manual verify** — upload the sample CSV via the app/curl; poll job → `done` with skipped>0; transactions present.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(worker): CSV import processor with dedupe + import report"
```

### Task 5.3: Rollup maintenance + compare_periods (TDD the math)

**Files:**
- Create: `packages/contracts/src/rollups.ts` (pure delta math), `apps/worker/src/processors/rollup.processor.ts`
- Modify: `apps/api/src/ai/tools/index.ts` (`compare_periods` → real)
- Test: `packages/contracts/src/rollups.test.ts`

- [ ] **Step 1: Write failing test** for `periodDelta`:

```ts
import { periodDelta } from './rollups';
it('computes percent change vs baseline average', () => {
  const r = periodDelta({ current: 300, baselineMonths: [200, 200, 200] });
  expect(r.baseline).toBe(200);
  expect(r.deltaPct).toBeCloseTo(50);   // 300 vs 200 => +50%
});
it('handles zero baseline without dividing by zero', () => {
  expect(periodDelta({ current: 100, baselineMonths: [0, 0] }).deltaPct).toBeNull();
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `rollups.ts`** — `periodDelta({current, baselineMonths})` → `baseline = avg(baselineMonths)`; `deltaPct = baseline === 0 ? null : ((current-baseline)/baseline)*100`.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: `rollup.processor.ts`** — on `ROLLUP_REBUILD`: recompute `MonthlyRollup` for the user via a single grouped SQL (`GROUP BY date_trunc('month', postedAt), category`) and upsert. Idempotent.

- [ ] **Step 6: Real `compare_periods` tool** — reads `MonthlyRollup` for the current month + N prior months (via `prisma.withUser`), calls `periodDelta`, returns `{ current, baseline, deltaPct }`. Replace the Phase-4 stub.

- [ ] **Step 7: Manual verify** — ask "am I spending more than usual this month?" → answer cites delta from rollups (verify it reads MonthlyRollup, not raw, e.g. by logging the query).

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: worker-maintained monthly rollups + compare_periods trend tool"
```

---

## Phase 6 — Receipt OCR (first to cut under time pressure)

### Task 6.1: Vision extraction + receipt processor

**Files:**
- Create: `apps/worker/src/processors/receipt-ocr.processor.ts`, `packages/contracts/src/receipt.ts` (zod schema + parse)
- Test: `packages/contracts/src/receipt.test.ts`

- [ ] **Step 1: Write failing test** for `receiptToTransaction(extracted, userId)` — maps a well-formed extraction to a Transaction input; for `confidence < 0.5` returns `{ needsConfirmation: true }` instead.

```ts
import { receiptToTransaction } from './receipt';
it('maps a confident extraction to a transaction', () => {
  const r = receiptToTransaction({ merchant: 'Tesco', total: 12.5, date: '2026-03-01', confidence: 0.9 }, 'u1');
  expect(r.needsConfirmation).toBe(false);
  expect(r.transaction?.amount).toBe(-12.5);
});
it('flags low-confidence for confirmation', () => {
  expect(receiptToTransaction({ merchant: '?', total: 0, date: '', confidence: 0.2 }, 'u1').needsConfirmation).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement `receipt.ts`** — zod schema `{ merchant, total, date, confidence }`; `receiptToTransaction` applies the sign convention and the confidence threshold.

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: `receipt-ocr.processor.ts`** — `generateText` with `Output.object` (the receipt schema) using `AIHelper.getModel(PARSE_VISION, env, cfg)`, passing the image as a vision content part. On confident result → insert transaction (source `receipt`) → enqueue rollup. On low confidence → store nothing; surface back to the user (write status to a small `ReceiptResult` row or return via job result).

- [ ] **Step 6: API upload endpoint** — `@Post('receipt')` (guarded, multipart) → base64 → enqueue `RECEIPT_OCR`. Web: an upload button in the chat composer.

- [ ] **Step 7: Manual verify** — upload a clear receipt image → transaction created; upload a blurry one → assistant asks to confirm.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: receipt OCR via vision model -> transaction with low-confidence guard"
```

---

## Phase 7 — Docs, polish, test pass

### Task 7.1: README / design note

**Files:**
- Create: `README.md`

- [ ] **Step 1:** Write the README required by the brief: setup instructions (`corepack enable && pnpm install && pnpm db:up && pnpm db:migrate && pnpm db:seed && pnpm dev`); what's built vs stubbed (spec §10); architecture + the scale story (spec §9 — emphasize aggregation-in-DB, rollups, RLS, safe SQL fallback); model-routing rationale; assumptions/trade-offs/limitations (spec §15); what was cut and why.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs: README with setup, architecture, scale story, and trade-offs"
```

### Task 7.2: Full test + typecheck pass

- [ ] **Step 1:** `pnpm -w typecheck` → fix any errors.
- [ ] **Step 2:** `pnpm -w test` → all unit tests green (config, dedupe, AIHelper, sql-validator, tools, csv-import, rollups, receipt).
- [ ] **Step 3: Commit** any fixes: `git commit -m "test: green typecheck + unit suite across workspace"`.

### Task 7.3 (stretch): RLS isolation integration test

**Files:**
- Create: `apps/api/test/rls.int.test.ts`

- [ ] **Step 1:** Using Testcontainers (COPY helpers FROM bugsport `packages/testing`), spin Postgres, apply migrations, create users A and B with transactions, then assert that `readonly-sql.service.run(A, 'SELECT * FROM "Transaction"')` returns zero of B's rows. Mark skippable via `SKIP_INTEGRATION=1`.

- [ ] **Step 2: Commit** `git commit -m "test: RLS tenant-isolation integration test (testcontainers)"`.

---

## Self-review notes (coverage map)

- Spec §2 layout → Tasks 0.1, 0.2, 1.1, 3.1, 5.1.
- Spec §3 docker → Task 0.3.
- Spec §4 data model → Task 1.1. §5 RLS → Tasks 1.2, 2.1 (withUser), 4.2 (RO exec).
- Spec §6 AIHelper → Task 3.1. §7 agent loop+tools → Tasks 3.2, 4.3. §8 safe SQL → Tasks 4.1, 4.2.
- Spec §9 scale (rollups) → Tasks 5.2, 5.3. §10 features → Phases 2–6. §11 edge cases → 5.2 (CSV), 6.1 (receipt), system-prompt (ambiguous/unanswerable) in 4.3.
- Spec §12 tests → tests embedded in 0.2, 1.3, 3.1, 4.1, 4.3, 5.2, 5.3, 6.1, 7.2, 7.3.
- Spec §14 roadmap → phase order matches.
