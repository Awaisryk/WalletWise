# WalletWise — Design Spec

**Status:** Approved (2026-06-05)
**Context:** Full-Stack AI Engineer take-home. Personal finance assistant: multi-user, log in, connect financial data, talk to it in natural language. Build window ~6 hours. Scoping is explicitly part of the assessment — a narrow slice that genuinely works beats a broad half-built set.

This spec is the source of truth. We implement strictly against it and do not diverge ad hoc.

---

## 1. Goals & non-goals

### What the assessment actually scores (and how this design answers it)
- **System & scalability design** → aggregation in Postgres, never the prompt; worker-maintained rollups; bounded tools.
- **Handling large context** → raw transactions almost never enter the LLM prompt; the DB aggregates, the model reasons over small results.
- **Routing & model selection** → `AIHelper` task→provider map; cheap text model for chat, multimodal only when an image is present; dev=local gpt-oss, prod=Groq gpt-oss-120b.
- **Multi-step / agentic reasoning** → single tool-calling agent loop (`streamText` + `stepCountIs`) that gathers what it needs across steps.
- **Edge-case & failure handling** → dedup, junk-row reports, low-confidence receipts, ambiguous/unanswerable questions handled explicitly.
- **Pragmatism (build vs buy)** → SuperTokens for auth, Prisma, BullMQ; effort spent on the hard parts (scale, safe SQL fallback, rollups).
- **Communication** → README/design note explains every decision, trade-off, and stub.

### Non-goals (explicitly out of scope for the build)
- Real bank integrations (Plaid etc.) — we ingest the provided CSV / mock endpoint.
- Object storage for receipts (process-and-discard; prod note only).
- Production deploy (k8s/CD) — described, not built.
- Multi-agent orchestration, vector/semantic memory, daily/weekly rollup granularity.

---

## 2. Stack & monorepo layout

pnpm + Turbo, Node 24. Mirrors existing `bugsport` conventions.

```
apps/
  api/        NestJS + Fastify + Prisma — auth, /ai/chat stream, tool execution, uploads
  web/        React + Vite + Zustand + Tailwind + shadcn/ui + ai-sdk v6 (useChat)
  worker/     NestJS application context (no HTTP) + BullMQ consumer
packages/
  config/     zod-validated env loader (shared by api + worker)
  contracts/  shared zod schemas + TS types (DTOs, tool I/O, queue payloads)
  ai/         AIHelper port: AITask/AIProvider enums, model map, provider factories, cost calc
infra/
  db/         Prisma schema + migrations + RLS policy SQL + CSV seed script
  compose/    docker-compose.yml + Dockerfiles + .env
```

**Trimmed from bugsport** (commodity, not worth 6h): MinIO, Loki, Promtail.

### Tooling / versions (pinned to match references)
- `pnpm@10.x` via `packageManager`; Node `>=24` via `.nvmrc`.
- Turbo for `dev`/`build`/`test`/`lint`/`typecheck`.
- TypeScript strict (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`, `experimentalDecorators`, `emitDecoratorMetadata`, `module: NodeNext`.
- AI SDK v6: `ai@^6`, `@ai-sdk/openai`, `@ai-sdk/groq`, `@ai-sdk/openai-compatible`, `@ai-sdk/react`.

---

## 3. Services & docker

`infra/compose/docker-compose.yml` services:

| Service | Image | Notes |
|---|---|---|
| `postgres` | `postgres:16-alpine` | app DB; healthcheck `pg_isready` |
| `supertokens-db` | `postgres:16-alpine` | separate auth DB |
| `supertokens` | `registry.supertokens.io/supertokens/supertokens-postgresql:9.x` | core; depends on supertokens-db |
| `redis` | `redis:7-alpine` | BullMQ + cache |
| `migrate` | built | one-shot `prisma migrate deploy`; other services wait on it |
| `api` | built (`apps/api/Dockerfile`) | depends on postgres/redis/supertokens healthy + migrate complete |
| `worker` | built (`apps/worker/Dockerfile`) | no exposed port |

Connection strings via env only (no secrets in YAML). `DATABASE_URL` (app role), `DATABASE_URL_RO` (read-only role for the SQL fallback), `REDIS_URL`, `SUPERTOKENS_CORE_URL`.

---

## 4. Data model (Prisma / Postgres)

```prisma
model User {
  id        String   @id @default(uuid())
  authId    String   @unique          // SuperTokens user id
  email     String   @unique
  createdAt DateTime @default(now())
}

model Account {
  id     String @id @default(uuid())
  userId String
  name   String
  type   String                        // checking | credit | savings | ...
}

model Transaction {
  id           String   @id @default(uuid())
  userId       String
  accountId    String?
  postedAt     DateTime
  amount       Decimal                  // negative = spend, positive = income (documented)
  currency     String   @default("USD")
  merchantRaw  String
  merchantNorm String?
  category     String?
  source       String                   // csv | receipt | manual
  dedupeHash   String                   // sha256(userId|postedAt|amount|merchantRaw)
  createdAt    DateTime @default(now())

  @@unique([userId, dedupeHash])
  @@index([userId, postedAt])
  @@index([userId, category, postedAt])
}

model MonthlyRollup {
  userId      String
  month       DateTime                  // first of month, UTC
  category    String
  txnCount    Int
  totalAmount Decimal
  @@id([userId, month, category])
}

model UserFact {
  id        String   @id @default(uuid())
  userId    String
  key       String
  value     String
  kind      String                      // income | budget_rule | preference | other
  createdAt DateTime @default(now())
  @@index([userId])
}

model Budget {
  id           String  @id @default(uuid())
  userId       String
  category     String
  monthlyLimit Decimal
}

model ImportJob {
  id           String   @id @default(uuid())
  userId       String
  status       String                   // pending | running | done | failed
  rowsTotal    Int      @default(0)
  rowsImported Int      @default(0)
  rowsSkipped  Int      @default(0)
  report       Json?
  createdAt    DateTime @default(now())
}
```

**Sign convention:** spend stored as negative `amount`; documented once and applied everywhere. Aggregations report absolute spend.

---

## 5. Row-Level Security (tenant isolation)

RLS is the real mechanism behind "make sure it's not going for other users' data," and it protects the SQL fallback at the database layer.

- Enable RLS on `Transaction`, `Account`, `MonthlyRollup`, `UserFact`, `Budget`, `ImportJob`.
- Policy per table: `USING (user_id = current_setting('app.current_user_id')::uuid)`.
- Every request/transaction sets `app.current_user_id` via `SET LOCAL` before queries run (a small Prisma middleware / transaction wrapper).
- The migrate role / table owner bypasses RLS; the **app role and read-only role do not**.
- Net effect: even a hand-written `SELECT * FROM transactions` through the fallback returns only the current user's rows — enforced by Postgres, not application code.

RLS policies live in a dedicated migration SQL file in `infra/db`.

---

## 6. AI layer (`packages/ai`, AIHelper port)

Port the resume-plus `AIHelper` pattern: a single source of truth for model selection. No model strings hardcoded in controllers/services.

```ts
enum AITask { CHAT, PARSE_VISION }     // extend later; keep minimal for the build
enum AIProvider { LOCAL, GROQ, OPENAI }

// MODEL_MAPPINGS: Record<AITask, { dev: ModelConfig; prod: ModelConfig }>
CHAT:        { dev: LOCAL gpt-oss,            prod: GROQ openai/gpt-oss-120b (reasoningEffort: 'low') }
PARSE_VISION:{ dev: GROQ llama-4-scout,       prod: GROQ llama-4-scout }   // gpt-oss text-only → no local vision path
```

- `LOCAL` via `createOpenAICompatible({ baseURL: LOCAL_AI_BASE_URL })` (gpt-oss).
- `GROQ` via `createGroq({ apiKey: GROQ_API_KEY })`.
- `getModel(task)`, `getProviderOptions(task)`, `getTemperature(task)`, `calculateCost(usage, task)`.
- **gpt-oss is text-only** → receipts must route to a multimodal model (Groq `llama-4-scout` / Gemini flash-lite). This split is the model-selection signal.
- Provider/model env overrides supported (`AI_PROVIDER`, `CHAT_MODEL`, etc.) as in resume-plus.
- PostHog tracing wrapper is **optional/stretch** — interface allows it, off by default.

---

## 7. Agent loop & tools

One multi-step agent loop per turn:

```ts
streamText({
  model: AIHelper.getModel(AITask.CHAT),
  system,                      // includes the user's relevant UserFacts
  messages,
  tools,
  stopWhen: stepCountIs(6),
  providerOptions: AIHelper.getProviderOptions(AITask.CHAT),
})
```

Streamed to the client with `pipeUIMessageStreamToResponse`. Client consumes via `useChat` (`@ai-sdk/react`) with `DefaultChatTransport`. A `data-cost` transient streams per-turn token/cost telemetry.

### Tool catalog (the agent's well-defined surface)

| Tool | Input (zod) | Reads | Returns |
|---|---|---|---|
| `query_spending` | `{ category?, merchant?, from, to }` | rollups when whole-month aligned, else bounded raw | `{ total, txnCount, currency }` |
| `compare_periods` | `{ category?, period, baseline }` | **MonthlyRollup only** | `{ current, baseline, deltaPct }` |
| `list_transactions` | `{ category?, from, to, sort, limit<=50 }` | raw, capped | rows (id, date, merchant, amount, category) |
| `save_user_fact` | `{ key, value, kind }` | — | `{ ok }` |
| `get_user_facts` | `{ kind? }` | UserFact | facts[] |
| `run_readonly_sql` *(stretch)* | `{ sql }` | read-only role under RLS | rows (capped) |

**Tool design rules:**
- Tools return aggregates or capped rows — never an unbounded dump.
- Every tool is scoped to the current user (RLS + explicit `userId`).
- The fixed tools cover the common questions cheaply; `run_readonly_sql` *(stretch)* is the fallback for the long tail.

---

## 8. The `run_readonly_sql` safe fallback  *(STRETCH — build only if time remains)*

Defense in depth — four independent layers:

1. **RLS** (§5): physically restricts rows to the current user, regardless of query text.
2. **Dedicated read-only Postgres role:** `GRANT SELECT` only — no INSERT/UPDATE/DELETE/DDL possible at the privilege level. Used via `DATABASE_URL_RO`.
3. **Validator (pre-execution):** parse and reject unless it is exactly one statement; statement must be `SELECT` (or `WITH ... SELECT`); reject multiple statements (`;`), comments that hide payloads, write keywords, and access to `pg_catalog` / `information_schema` / `pg_*`.
4. **Resource caps:** `SET LOCAL statement_timeout = 3000ms`; force/append a `LIMIT` (default 200); cap returned payload size.

On rejection, return a structured error the agent can relay ("I can only run read-only lookups; that query was blocked because …"). The validator is **security-critical and gets explicit unit tests** including injection/escape attempts.

---

## 9. Scale story — surviving 10×–100×

All three mechanisms are built, not just described:

1. **Aggregation in the query layer.** `query_spending` is `SUM(...) GROUP BY` — cost is flat in ledger size; the model sees a few numbers.
2. **Worker-maintained `MonthlyRollup`.** CSV import and new transactions enqueue a rollup job; `compare_periods` reads only rollups (dozens of rows) no matter how many years exist. This also makes "unusual activity" (#4) and "compare across time" (#5) nearly free.
3. **Bounded fallback (stretch).** `run_readonly_sql` cannot scan unboundedly (timeout + LIMIT + RLS). Not in the MVP; mechanisms 1–2 carry the core scale story on their own.

**Described in the design note (not built):** Redis caching of hot aggregates, monthly table partitioning, read replicas, the import queue as the 100× ingestion path, an index review for new query shapes.

---

## 10. Feature plan — MVP vs stretch vs stubbed

**MVP — built for real:**
- Auth + multi-user (SuperTokens + RLS isolation).
- CSV import via worker: dedup, missing-field coercion/skip, junk rows surfaced in `ImportJob.report`.
- #1 Answer spending questions (`query_spending`, `list_transactions`).
- #5 Compare across time (`compare_periods` on rollups).
- #10 Remember user context (`save_user_fact` / `get_user_facts`, facts injected into system prompt).

**Stretch — build only if time remains (in priority order):**
1. The `run_readonly_sql` safe fallback (§8) — the fixed tools cover the assessed core questions without it; this extends coverage to the open-ended long tail.
2. #2 Receipt OCR (upload → worker vision → transaction).

**Stubbed / described (infra makes them close, but not claimed unless they work):** #3 subscriptions, #4 anomaly flag, #6 budgets (schema present, tracking stubbed), #7 merchant web-lookup, #8 summarize, #9 cut-back. The note explains how each slots onto the existing tools. RLS remains in the MVP regardless — it is the multi-user isolation mechanism for every query.

---

## 11. Edge-case handling

- **Messy CSV:** dedupe hash (upsert/skip); rows missing required fields are coerced or skipped and **counted in the import report** (never silently dropped); junk rows reported.
- **Bad receipt** (blurry/rotated/foreign): vision extraction returns structured fields **plus a confidence**; low confidence → the assistant asks the user to confirm rather than fabricating a transaction.
- **Ambiguous question:** the agent states an explicit assumption or asks one clarifying question.
- **Unanswerable from data:** says so plainly; no invented numbers.
- **Contradictions / expensive queries:** bounded tools, timeouts, and rollups keep the system honest and cheap.

---

## 12. Testing strategy (unit tests required)

- **api + worker:** Jest + `@swc/jest`. **web:** Vitest + happy-dom + React Testing Library.
- LLM calls mocked in unit tests.
- **High-value unit tests:**
  - CSV parse + dedupe (duplicates, missing fields, junk rows).
  - Rollup math + `compare_periods` (delta %, baseline averaging).
  - **`run_readonly_sql` validator** — explicit injection/escape/multi-statement/system-table attempts.
  - Each tool handler against a mocked DB.
  - `AIHelper` model selection (dev vs prod, vision routing).
  - Receipt extraction parsing (well-formed + low-confidence).
- **Stretch:** Testcontainers integration test proving RLS isolation across two users.

---

## 13. Environment variables

```
# core
NODE_ENV, PORT, CLIENT_ORIGIN, API_DOMAIN
DATABASE_URL                 # app role
DATABASE_URL_RO              # read-only role (SELECT only) for run_readonly_sql
REDIS_URL

# auth
SUPERTOKENS_CORE_URL, SUPERTOKENS_API_KEY

# ai
AI_ENV=dev|prod              # selects dev/prod branch in AIHelper
LOCAL_AI_BASE_URL            # gpt-oss openai-compatible endpoint
GROQ_API_KEY
CHAT_MODEL, AI_PROVIDER, AI_REASONING_EFFORT   # optional overrides

# worker
WORKER_CONCURRENCY=5
```

Validated by `packages/config` (zod) at boot; api and worker each have their own schema extending a shared base.

---

## 14. Roadmap (phased; tests within each phase)

| Phase | Deliverable | Tests added | ~Time |
|---|---|---|---|
| 0 | Monorepo scaffold, Turbo, tsconfig, docker-compose (pg+redis+supertokens), `packages/config` | config env validation | 0:45 |
| 1 | Prisma schema + migrations + **RLS** + CSV seed script | dedupe-hash unit | 0:45 |
| 2 | SuperTokens auth + user sync (signUp override) + protected routes | — | 0:30 |
| 3 | `packages/ai` AIHelper port + `/ai/chat` streaming + web chat UI (useChat + shadcn) | AIHelper model selection | 1:00 |
| 4 | Tools: `query_spending`, `list_transactions`, facts (wired into chat) | tool handlers | 0:45 |
| 5 | Worker + queue: CSV import job + rollup maintenance + `compare_periods` | CSV import, rollup math | 1:00 |
| 7 | README/design note + test pass + polish | — | 0:15+ |
| **S1** *(stretch)* | Safe `run_readonly_sql` fallback: validator + RO executor + wire into tools | validator (injection) | 1:00 |
| **S2** *(stretch)* | Receipt OCR: upload → worker vision job → transaction | extraction parsing | 0:45 |

**MVP = Phases 0→5 then Phase 7** (working multi-user assistant: spending + trend questions over imported data, with memory). Stretch items **S1 then S2**, in that priority order, only if time remains. RLS is built in Phase 1 (MVP) because it is required for multi-user isolation; it also backstops S1 if/when that lands.

---

## 15. Assumptions, trade-offs, limitations

- Single-agent tool loop over multi-agent — cheaper, lower latency, sufficient for these tasks.
- Process-and-discard receipts — prod would persist originals to S3.
- Monthly rollup granularity — daily/weekly is a future axis.
- gpt-oss text-only → receipts route to a multimodal model.
- 6h means most of the 10 capabilities are intentionally stubbed; the rollup + tool + RLS infra is the foundation they'd build on.
- Sign convention (spend negative) is a documented assumption about the input data; the importer normalizes to it.

---

## 16. Definition of done (for the build window)

- `docker compose up` brings the stack up; migrations + RLS applied.
- A user can sign up, import the sample CSV, and ask: "how much did I spend on groceries last month?", "what was my biggest purchase in March?", "am I spending more than usual this month?" — and get correct, fast answers backed by the DB, not the prompt.
- The assistant remembers a stated fact and applies it.
- *(Stretch)* The read-only SQL fallback answers an off-catalog question and provably cannot escape the user's rows or write.
- Unit tests pass for the high-value targets in §12.
- README explains approach, decisions, trade-offs, and exactly what is stubbed/skipped.
