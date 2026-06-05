# WalletWise — Design Spec

**Status:** Approved (2026-06-05)
**Context:** Full-Stack AI Engineer take-home. Personal finance assistant: multi-user, log in, connect financial data, and ask questions in natural language. Build window ~6 hours. Scoping is part of the assessment; a narrow working slice beats a broad half-built product.

This spec is the source of truth. Implement against it and do not add extra security/database machinery unless the build is already complete.

---

## 0. Auth And User Data

Use normal SuperTokens auth. Keep the ownership model simple:

1. `User.id` is the app's internal user id.
2. `User.authId` stores the SuperTokens user id.
3. User-owned rows store `userId`, which points to `User.id`.
4. API routes derive the current `User.id` from the SuperTokens session.
5. The client and the LLM never provide `userId`; server code adds it to queries and writes.

The assistant can only access data through fixed, typed tools.

---

## 1. Goals & Non-Goals

### What the assessment scores

- **System & scalability design** -> aggregation in Postgres, worker-maintained rollups, bounded tool outputs.
- **Handling large context** -> raw transactions are not sent to the LLM; the DB returns compact facts and aggregates.
- **Routing & model selection** -> cheap text model for chat; multimodal model only for receipt OCR if the stretch task is built.
- **Multi-step reasoning** -> one tool-calling agent loop that gathers data through tools before answering.
- **Edge cases** -> messy CSV rows, duplicates, ambiguity, and unanswerable questions are handled explicitly.
- **Pragmatism** -> SuperTokens for auth; Prisma, BullMQ, and typed tools for the product-specific work.
- **Communication** -> README explains what was built, what was skipped, and why.

### Non-goals

- Real bank integrations such as Plaid.
- Production deployment.
- Object storage for receipt images.
- Vector memory and multi-agent orchestration.
- Sub-daily or per-merchant rollups. Rollups are stored at a **daily** grain and bucketed into week/month/year in code.

---

## 2. Stack & Layout

pnpm + Turbo, Node 22.

```
apps/
  api/        NestJS + Fastify + Prisma — auth, chat stream, tools, uploads
  web/        React + Vite + Zustand + Tailwind + shadcn/ui + ai-sdk useChat
  worker/     NestJS application context + BullMQ consumer
packages/
  config/     zod-validated env loader
  contracts/  shared zod schemas + TS types
  ai/         AIHelper: task/provider routing and model config
infra/
  db/         Prisma schema + migrations + CSV seed script
  compose/    docker-compose.yml + Dockerfiles + .env.example
```

Services: Postgres, SuperTokens core + auth DB, Redis, API, worker, and migrate container.

---

## 3. Data Model

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
  type   String
}

model Transaction {
  id           String   @id @default(uuid())
  userId       String
  accountId    String?
  postedAt     DateTime
  amount       Decimal                  // negative = spend, positive = income
  currency     String   @default("USD")
  merchantRaw  String
  merchantNorm String?
  category     String?
  source       String                   // csv | receipt | manual
  dedupeHash   String
  createdAt    DateTime @default(now())

  @@unique([userId, dedupeHash])
  @@index([userId, postedAt])
  @@index([userId, category, postedAt])
}

model DailyRollup {
  userId      String
  day         DateTime                  // first instant of day, UTC
  category    String
  txnCount    Int
  totalAmount Decimal                   // positive spend total from amount < 0
  @@id([userId, day, category])
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

Sign convention: expenses are stored as negative `amount`; income is positive. Spending queries and spending rollups filter `amount < 0` and report positive totals.

---

## 4. Auth Flow

- SuperTokens handles sign-up, sign-in, sessions, and cookies.
- On sign-up, the API upserts `User { authId, email }`.
- `SessionGuard` verifies the SuperTokens session and resolves the app `User.id`.
- Protected routes use that server-side `User.id` for all reads/writes.

---

## 5. AI Layer

`packages/ai` owns model selection. Controllers and tools do not hardcode provider strings.

```ts
enum AITask { CHAT, PARSE_VISION }

CHAT:
  dev  -> local OpenAI-compatible gpt-oss
  prod -> Groq openai/gpt-oss-120b, low reasoning effort

PARSE_VISION:
  dev/prod -> Groq multimodal model, only if receipt OCR stretch is built
```

The model split is part of the cost/latency story: use a cheap text model for normal finance chat, and only call a multimodal model when an image is uploaded.

---

## 6. Agent Loop & Tools

One `streamText` tool-calling loop per turn:

```ts
streamText({
  model: AIHelper.getModel(AITask.CHAT),
  system,
  messages,
  tools,
  stopWhen: stepCountIs(6),
})
```

Tool catalog:

| Tool | Purpose | Data access |
|---|---|---|
| `query_spending` | Spend total for category/merchant/date range | Indexed raw aggregate with `amount < 0` |
| `compare_periods` | Current period vs baseline, at week/month/year granularity | `DailyRollup` only (days bucketed into periods) |
| `list_transactions` | Biggest purchase / recent rows | Raw transactions, capped at 50, filtered to current user |
| `save_user_fact` | Remember user preference/context | `UserFact` write for current user |
| `get_user_facts` | Retrieve remembered context | `UserFact` read for current user |

Tool rules:

- Tools return aggregates or capped rows, never full history.
- Tools are constructed with the server-side `userId`.
- The LLM supplies only non-identity parameters such as dates, category, merchant, and limit.
- If the fixed tools cannot answer a question, the assistant says what is missing instead of inventing data.

---

## 7. Scale Story — 10x To 100x Data

The long-history strategy is deliberate:

1. **Never put raw history in the prompt.** The LLM receives compact query results, not years of transactions.
2. **Use indexed raw queries only for narrow drilldowns.** For example, biggest purchase in March reads a bounded date range for the current user.
3. **Use daily rollups for trend questions.** CSV import and new transactions enqueue a rollup rebuild that recomputes per-day, per-category totals. `compare_periods` buckets those days into the requested granularity (week/month/year) and compares the current period against a trailing baseline — "Am I spending more than usual this month/this week?" reads a few dozen rollup rows, not the full ledger.

Production extensions described in the README: Redis caching for hot aggregates, table partitioning by month, read replicas, and more rollup grains if product questions need them.

---

## 8. Feature Plan

MVP built for real:

- SuperTokens auth + user records.
- CSV import with dedupe, skipped-row report, and transaction inserts.
- Spending questions through `query_spending` and `list_transactions`.
- Trend comparison through `compare_periods` on `DailyRollup` (bucketed to week/month/year).
- User context memory through `save_user_fact` / `get_user_facts`.

Stretch:

- Receipt OCR: upload image -> multimodal extraction -> transaction, with low-confidence confirmation.

Stubbed/described:

- Subscriptions, anomaly detection, budgets, merchant web lookup, summaries, and cut-back suggestions.

---

## 9. Edge Cases

- Messy CSV: duplicates skipped, missing fields reported, junk rows counted.
- Ambiguous question: assistant states an assumption or asks one clarifying question.
- Unanswerable question: assistant says what data or capability is missing.
- Expensive request: tools stay bounded and prefer rollups for long-history comparisons.
- Bad receipt image: stretch OCR returns confidence; low confidence asks for confirmation.

---

## 10. Testing Strategy

High-value tests:

- CSV parse + dedupe.
- Rollup math and `compare_periods`.
- Tool handlers include current `userId` in every query.
- Spending tools filter `amount < 0` so income does not offset expenses.
- `list_transactions` caps rows at 50.
- AIHelper model routing.
- Receipt parsing only if stretch OCR is built.

---

## 11. Environment Variables

```
NODE_ENV
PORT
CLIENT_ORIGIN
DATABASE_URL
REDIS_URL
SUPERTOKENS_CORE_URL
SUPERTOKENS_API_KEY
AI_ENV=dev|prod
LOCAL_AI_BASE_URL
GROQ_API_KEY
CHAT_MODEL
AI_PROVIDER
AI_REASONING_EFFORT
WORKER_CONCURRENCY=5
```

---

## 12. Definition Of Done

- `docker compose up` starts Postgres, Redis, SuperTokens, API, and worker.
- A user can sign up/sign in.
- A user can import the sample CSV.
- The assistant correctly answers:
  - "How much did I spend on groceries last month?"
  - "What was my biggest purchase in March?"
  - "Am I spending more than usual this month?"
- The assistant remembers a stated fact and applies it later.
- Unit tests pass for CSV parsing, rollups, tools, and model routing.
- README explains setup, architecture, scale strategy, trade-offs, and skipped features.
