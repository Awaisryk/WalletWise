# WalletWise

A multi-user personal-finance assistant. Users sign in, import their transactions from a CSV bank export, and ask questions in natural language — *"How much did I spend on groceries last month?"*, *"Why was May more expensive than April?"*, *"What recurring subscriptions do I have?"*. The assistant answers by calling a small set of **typed tools** that aggregate data in Postgres; raw transaction history is never placed in the model's prompt. It can summarize spending, compare periods, explain deltas, find likely subscriptions, flag charges that stand out, track simple budgets, and remember stated facts for later turns.

This is a deliberately **narrow but complete vertical slice**: auth → CSV import → grounded spending Q&A, built to demonstrate the system design that keeps an LLM finance assistant correct and cheap as a user's history grows from hundreds to hundreds of thousands of rows.

---

## Setup / Run

Requires **Node 22** and **Docker** (for Postgres, SuperTokens, and Redis). [Corepack](https://nodejs.org/api/corepack.html) pins pnpm.

```bash
corepack enable
pnpm install

# Local env: copy the committed example and fill in your AI credentials.
cp infra/compose/.env.example infra/compose/.env.dev
#   Pick ONE chat model provider:
#   - Local:  AI_ENV=dev  + LOCAL_AI_BASE_URL=<local OpenAI-compatible server,
#                            e.g. LM Studio / Ollama at http://localhost:1234/v1>
#   - Groq:   AI_ENV=prod + GROQ_API_KEY=<key>          (Groq gpt-oss-120b)
#   - OpenAI: AI_PROVIDER=openai + OPENAI_API_KEY=<key>  (OPENAI_MODEL defaults to
#                            gpt-5; AI_PROVIDER=openai overrides AI_ENV)

pnpm infra:up       # docker: postgres + supertokens(-db) + redis
pnpm db:migrate     # apply the Prisma migrations to the app DB
pnpm db:seed        # load the sample CSV into a demo user (authId "seed-demo")
pnpm dev            # api (:4000) + web (:5173) + worker, all via turbo

# pnpm infra:down   # stop the docker services when you're done
```

Open **http://localhost:5173**, sign up with an email + password, upload `infra/db/sample/transactions.csv` (or your own export), and start asking questions.

`pnpm db:seed` populates a `demo@walletwise.dev` user directly in the database for testing the tools/rollups; it does not create SuperTokens credentials, so to use the **web app** sign up with your own email and import the sample CSV through the UI.

### Full container run (optional)

`pnpm compose:up` builds and runs everything — including the API, worker, and a one-shot migrate container — in Docker. `pnpm compose:down` tears it down (with volumes).

### Environment variables that matter

Validated by a zod loader in `packages/config` (`apps/api` and `apps/worker` fail fast on a bad env). See `infra/compose/.env.example` for the full list with local defaults.

| Var | Purpose |
|---|---|
| `AI_ENV` | `dev` (local OpenAI-compatible model) or `prod` (Groq). Selects model routing unless `AI_PROVIDER=openai`. |
| `LOCAL_AI_BASE_URL` | OpenAI-compatible base URL for dev chat (default `http://localhost:1234/v1`). |
| `GROQ_API_KEY` | Required when `AI_ENV=prod` (and for receipt OCR routing, which is stubbed). |
| `AI_PROVIDER` | Set to `openai` to use OpenAI for chat (overrides `AI_ENV`). Otherwise leave blank. |
| `OPENAI_API_KEY` | Required when `AI_PROVIDER=openai`. |
| `OPENAI_MODEL` | OpenAI chat model id; defaults to `gpt-5` (e.g. set `gpt-5-mini` for a cheaper tier). |
| `DATABASE_URL` | Postgres connection for the app DB (api, worker, migrate, seed). |
| `REDIS_URL` | Redis for the BullMQ queue and the per-conversation cost counter. |
| `SUPERTOKENS_CORE_URL` / `SUPERTOKENS_API_KEY` | SuperTokens core endpoint + key. |
| `CLIENT_ORIGIN` | Browser origin for CORS / cookies (`http://localhost:5173` in dev). |
| `WORKER_CONCURRENCY` | BullMQ worker concurrency (worker only, default 5). |

The web client runs on **Vite's port 5173** and proxies `/auth`, `/ai`, and `/import` to the API on **:4000** (see `apps/web/vite.config.ts`). Proxying through the Vite origin keeps requests same-origin so the SuperTokens session cookie is sent automatically.

---

## Architecture

A pnpm + Turbo monorepo, Node 22.

```
apps/
  api/        NestJS + Fastify — SuperTokens auth, streaming chat, typed tools, CSV upload
  web/        React + Vite + Tailwind + shadcn/ui — auth gate, CSV upload+poll, useChat UI
  worker/     NestJS standalone context + BullMQ consumer — CSV import, rollup rebuild
packages/
  config/     zod-validated env loader (fail-fast) for api + worker
  contracts/  shared zod schemas + pure logic: dedupe hash, CSV parser, rollup math, queue names
  ai/         AIHelper — task→provider/model routing + per-call cost calculation
infra/
  db/         Prisma schema + migration + sample CSV + seed
  compose/    docker-compose (postgres, supertokens-db, supertokens, redis, migrate, api, worker)
```

### Request flow — a chat turn

```
browser (useChat)
   │  POST /ai/chat  { messages, conversationId }   (session cookie)
   ▼
SessionGuard ── verifies SuperTokens session ── resolves app User.id ───┐
   │                                                                    │ userId
   ▼                                                                    ▼
AiController ── builds the tool catalog scoped to userId ── runChat() (ai-sdk streamText)
   │                                                                    │
   │      ┌─────────────── agent loop (stopWhen stepCountIs(8)) ────────┤
   │      ▼                                                             │
   │   model decides → calls a typed tool (query_spending, …)           │
   │      ▼                                                             │
   │   tool runs an indexed Postgres aggregate / reads daily rollups    │
   │      ▼   (bounded result: a total, a delta, or ≤50 rows)           │
   │   result fed back to the model ────────────────────────────────────┘
   ▼
streamed tokens → browser, plus per-turn + cumulative cost in message metadata
```

The data layer is split by access pattern:

- **Spending totals / drilldowns** hit indexed raw `Transaction` aggregates for the current user (`query_spending`, `list_transactions`).
- **Named comparisons and explanations** use exact date-window aggregates (`compare_spending_ranges`, `explain_spending_change`) so a question like *"May vs Jan-Apr average"* does not get confused with a trailing-window trend.
- **Trends** (*"more than usual?"*) read pre-computed `DailyRollup` rows, bucketed into the requested period (`compare_periods`) — never raw rows.
- **Advisory tools** (`get_spending_breakdown`, `find_subscriptions`, `find_unusual_charges`, `get_budget_status`) return bounded, evidence-shaped summaries for the model to explain.

### Import / queue flow

```
POST /import/csv → creates an ImportJob (pending) + enqueues import.csv  →  202-style { jobId }
web polls GET /import/:id  ──────────────────────────────────────────────────────────────────┐
worker: import.csv → parse + dedupe + createMany(skipDuplicates) → write report → enqueue rollup.rebuild
worker: rollup.rebuild → DELETE+INSERT this user's DailyRollup (per day+category) from amount<0 (idempotent)
```

The API never parses the CSV inline — it hands the work to the worker so a large file doesn't block the request, and so import + rollup maintenance are retryable BullMQ jobs.

---

## Scale / large-context strategy

This is the core design decision, and it's about **what the LLM never sees**.

1. **Raw history is never in the prompt.** The model receives the user's question and *compact tool results* — a single total, a percentage delta, or at most 50 rows. A user with 200,000 transactions and a user with 200 produce prompts of the same size, because the aggregation happens in Postgres, not in the context window. This is what keeps the assistant both affordable and accurate at scale; stuffing a ledger into context would blow the window, cost a fortune, and still yield worse arithmetic than a `SUM`.

2. **Aggregates run in the database, on indexes.** `query_spending` is a `SUM`/`COUNT` filtered by `userId` + date range (+ optional category/merchant). The schema carries composite indexes `(userId, postedAt)` and `(userId, category, postedAt)`, so these stay index-range scans rather than full-table reads as history grows.

3. **Trend questions read daily rollups, so their cost is flat.** Every import (and any future write) enqueues a `rollup.rebuild` that recomputes the user's per-day, per-category spend totals into `DailyRollup`. `compare_periods` then **buckets those days into the requested granularity** — week, month (default), or year — and compares the most recent period to a trailing baseline average. *"Am I spending more than usual this month?"* and *"...this week?"* both read the same compact daily rows (dozens, not years of transactions); the period view is derived in code. The rebuild is a `DELETE + INSERT` for one user inside a single transaction, which makes it idempotent under retries and back-to-back imports.

4. **Explicit comparisons use exact windows.** `compare_periods` is deliberately only for *current period vs usual* questions. For questions with named windows, such as *"Compare May groceries to the average of Jan through Apr"*, `compare_spending_ranges` queries the exact ranges and returns the current total, baseline total/average, delta, and percent. For *"why did this period cost more?"*, `explain_spending_change` returns the total delta plus capped category and merchant drivers. This tool shape prevents the model from silently using the wrong baseline.

5. **Tool outputs are bounded by construction.** `list_transactions` caps `limit` at 50 server-side regardless of what the model asks for; aggregating tools return scalars or capped grouped rows. There is no tool that can return "all transactions".

**Production extensions (described, not built):** Redis caching of hot aggregates (the same "spend last month" recomputed across turns); Postgres table partitioning of `Transaction` by month so old partitions are rarely touched; read replicas for the analytical aggregate queries; date-bounding the rollup read to just the needed window (today it reads all of a user's daily rollups — still tiny, but bounded would scale further); and per-merchant rollups if product questions demand them. The daily grain already covers week/month/quarter/year comparisons by bucketing.

---

## Model routing / cost

Model selection lives entirely in `packages/ai` (`AIHelper`). Controllers and tools never hardcode a provider or model id — they ask for the model that belongs to a *task* in the current *environment*. This keeps the cost/latency story in one place:

| Task | dev | prod |
|---|---|---|
| `CHAT` | local OpenAI-compatible `gpt-oss` ($0) | Groq `openai/gpt-oss-120b`, `reasoningEffort: low` |
| `PARSE_VISION` | Groq Llama-4 Scout (multimodal) | Groq Llama-4 Scout (multimodal) |

The split is deliberate: normal finance chat uses a **cheap text model**, and a multimodal model is only ever invoked for a **receipt image** (the OCR stretch — routing is wired, the processor is stubbed). There's no reason to pay multimodal rates for "how much did I spend on coffee".

**Cost is computed and streamed.** On each turn's `finish`, `AIHelper.calculateCost` prices the usage (Groq gpt-oss-120b at $0.15/M input, $0.75/M output, cached input at 50%; local = $0) and the controller attaches both the **per-turn cost** and a **cumulative session cost** to the message metadata. The cumulative figure is kept in Redis keyed by conversation (24h TTL), written best-effort so a Redis hiccup never breaks the stream. Token counting is provider-tolerant — it normalizes the ai-sdk v6 usage shape and assorted raw provider payload keys.

---

## Security / multi-tenancy

Isolation is **application-level and enforced on every query**:

- `User.id` is the internal app id; `User.authId` holds the SuperTokens id. Every user-owned row carries `userId`.
- `SessionGuard` verifies the SuperTokens session and resolves the app `User.id`. The `@User('id')` decorator hands that server-derived id to controllers.
- **`userId` comes from the session — never from the client and never from the LLM.** Tools are constructed per-request via `buildTools({ prisma, userId })` and *close over* that id; the model can only supply non-identity parameters (dates, category, merchant, limit). There is no code path where a request body or a model argument can set `userId`.
- **No LLM-generated SQL.** The model's entire data-access surface is the fixed, typed tool catalog. It cannot author queries, so prompt injection cannot exfiltrate or mutate another user's data — the worst it can do is call an allowed tool with allowed parameters, all already scoped to the caller.
- The import-poll route uses `findFirst({ where: { id, userId } })` rather than `findUnique({ where: { id } })`, so one user can never read another's import job by guessing an id.

**Deliberate decision: no Postgres RLS.** Row-level security is the textbook answer, but it's fragile with connection pooling (the per-request `SET LOCAL app.user_id` has to be bound to the exact pooled connection serving the request, which is an easy and silent footgun under transaction-mode poolers), and it splits the authorization logic across two layers. For a single-service app where *every* query already flows through guarded controllers and closure-scoped tools, putting tenancy in one well-tested application layer is simpler and easier to reason about. The trade-off — losing the database as a last-line backstop — is mitigated by **tests that assert `userId` scoping** on every tool and the import path. (At larger scale or with multiple services hitting the same DB, RLS as defence-in-depth becomes worth the operational cost; it's a scale decision, not a correctness one.)

---

## What's built vs stubbed vs skipped

### Capability coverage — the brief's ten

The brief listed ten things the assistant should be able to do. **Eight are built**; two (receipt OCR and online merchant lookup) were deliberately scoped out — each needs a capability outside the imported-CSV + grounded-chat loop (a vision model; an external search API), and the brief explicitly rewards scoping over breadth.

| # | Asked for | Status | How we built it |
|---|---|---|---|
| 1 | Answer questions about spending | ✅ Built | `query_spending` (totals by category/merchant/date), `list_transactions` (recent rows / biggest purchase), `compare_spending_ranges` |
| 2 | Read a receipt from a photo | ⏭️ Skipped | Vision is *routed* (`AITask.PARSE_VISION` + the `RECEIPT_OCR` queue contract) but the worker throws "not implemented (stretch)" |
| 3 | Surface recurring subscriptions | ✅ Built | `find_subscriptions` — repeat merchant + steady cadence + stable amount, presented as **likely** with the evidence |
| 4 | Flag unusual activity | ✅ Built | `find_unusual_charges` — per-category-median outliers + large one-off charges, framed as **"stands out"**, not confirmed fraud |
| 5 | Compare across time | ✅ Built | `compare_periods` (week/month/year over daily rollups, anchored on real "today"), `compare_spending_ranges` |
| 6 | Track a budget | ✅ Built | `set_budget` + `get_budget_status` (this-month spend vs limit → ok / warning / over) |
| 7 | Look up unfamiliar charges (incl. online) | ⏭️ Skipped | Needs an external web-search API + key; intentionally out of scope |
| 8 | Summarise finances in plain English | ✅ Built | `get_spending_breakdown` (per-category totals + shares), `explain_spending_change` (deltas between periods) |
| 9 | Suggest where to cut back | ✅ Built | Grounded in `get_spending_breakdown`'s real per-category numbers — never invented |
| 10 | Remember user context | ✅ Built | `save_user_fact` / `get_user_facts`; remembered facts injected as late runtime context each turn |

System-level requirements (which the brief weighs heavily) are covered too:

| Requirement | Status | How |
|---|---|---|
| Fast / economical per request | ✅ | The database aggregates; the LLM sees compact tool results, never raw transaction rows |
| Holds up at 10×–100× data | ✅ | Indexed aggregates + pre-computed daily rollups; no query scans the full ledger |
| Many users, private per-user data | ✅ | SuperTokens auth; every query scoped to a server-side `userId`; the LLM never supplies an identity |
| Routing & model selection | ✅ | `AIHelper` — a cheap local/Groq text model for chat; the vision tier is reserved for the (cut) OCR path |
| Multi-step / agentic reasoning | ✅ | One tool-calling loop: gather what's needed via tools, then answer |
| Messy inputs & dead ends | ✅ | Import dedup + skipped-row report; the assistant says what's missing rather than guessing |
| Accuracy (no fabrication) | ✅ | Every number comes from a tool result; inferred results (subscriptions / unusual charges) are explicitly hedged |

**Two honest non-capability gaps:** chat transcripts are not persisted across page reloads (your imported *data* and *remembered facts* are), and answers are text only — no charts.

---

### Detail

**Built (works end-to-end):**
- SuperTokens email/password auth; on sign-up the API upserts a `User { authId, email }`.
- CSV import: async via the worker, with dedupe (per-user `dedupeHash`), a skipped-row report (duplicate / missing-field / malformed), and `createMany({ skipDuplicates: true })`.
- Data-status check: `get_data_status` answers whether the user has imported transactions, with counts, date coverage, and available categories.
- Spending Q&A: `query_spending` (totals) and `list_transactions` (recent rows / biggest purchase).
- Trend comparison: `compare_periods` over `DailyRollup`, bucketed to week/month/year.
- Exact range comparison: `compare_spending_ranges` for named windows and baseline averages.
- Spending-change explanations: `explain_spending_change` for total/category/merchant deltas between two periods.
- Spending breakdowns: `get_spending_breakdown` for summaries, top categories, and cut-back suggestions.
- Likely subscriptions: `find_subscriptions` scans subscription-category charges and returns repeat-cadence/stable-amount evidence.
- Unusual charges: `find_unusual_charges` returns category-median outliers and large one-off charges as items to review, not confirmed fraud.
- Budgets: `set_budget` and `get_budget_status` store simple per-category monthly limits and compare them with current-month spending.
- User memory: `save_user_fact` / `get_user_facts`; remembered facts and data coverage are injected as late runtime reference context so the stable system prompt remains cache-friendly.
- Per-turn + cumulative cost calculation, streamed to the client.

**Stretch — routed but not built:**
- Receipt OCR. `AITask.PARSE_VISION` routing and the `RECEIPT_OCR` queue contract exist; the worker processor throws *"not implemented (stretch)"*. Building it out would be: upload image → multimodal extraction (merchant/date/total/confidence) → low-confidence ⇒ ask the user to confirm, high-confidence ⇒ insert a negative spending transaction → enqueue a rollup rebuild.

**Stubbed / described, not implemented:**
- Merchant web-lookup enrichment, scheduled/periodic summaries, real bank integrations, and object storage for receipt images. These are natural follow-on features, but the assessment slice keeps the product loop focused on imported CSV data and grounded chat.

---

## Edge cases handled

- **Messy CSV.** Duplicate rows are dropped (within the file via a seen-hash set, and at insert via the `(userId, dedupeHash)` unique constraint); rows missing a required field (amount/merchant/date) are reported as `missing_field`; junk rows (wrong column count, unparseable date, non-numeric amount) are reported as `malformed`. Counts and per-line reasons land in the `ImportJob.report` the client polls. The bundled `sample/transactions.csv` intentionally contains 2 duplicates, a missing-amount row, and a junk row to exercise this.
- **Spending vs income sign.** Expenses are stored as **negative** `amount`, income as **positive**. Spending tools and rollups filter `amount < 0` and report **positive** totals (`abs`), so income never offsets expenses, and "biggest purchase" sorts by most-negative amount with income excluded — a $2,850 salary credit can't masquerade as a big purchase.
- **Ambiguous questions.** The model is free to state an assumption or ask one clarifying question; the bounded tools mean an over-broad query still returns a sane aggregate rather than a runaway result.
- **Ambiguous follow-ups.** For finance comparisons, the prompt explicitly avoids unsafe category carryover: *"Why was May more expensive than April?"* defaults to total spending, even if the previous turn discussed groceries. The model may only inherit a category when the user says "same category", "that category", or names the category again.
- **Unanswerable questions.** The system prompt instructs the assistant to **say what data or capability is missing rather than fabricate numbers**, and there is no tool that returns ungrounded figures — every number it reports comes from a tool result.

---

## Trade-offs & limitations

- **Single agent, single tool loop.** One `streamText` loop bounded at 8 steps gathers data through tools then answers. Simple and debuggable; no multi-agent orchestration or planning layer (out of scope, and not needed for these questions).
- **Daily rollup grain, partial current period.** `compare_periods` buckets daily rollups into week/month/year, so the most recent *bucket* (e.g. the current month) may be partial when compared against complete prior periods — fine for "more than usual so far?", but a same-day-of-period comparison (e.g. "month-to-date vs the same point last month") would need extra logic. A deliberate cut for the build window.
- **Rollups rebuilt, not incrementally updated.** Each import does a full per-user `DELETE + INSERT`. Correct and idempotent, but at very large per-user volumes an incremental upsert (touching only affected days) would be cheaper.
- **Heuristic detectors are evidence, not truth.** Subscriptions and unusual charges are intentionally framed as "likely" / "stands out" with the evidence returned by the tool. The MVP does not claim fraud detection, merchant identity resolution, or contractual subscription status.
- **Budgets are simple monthly category limits.** They are useful for the product loop, but not full envelope budgeting: no rollover, no account-level budgets, no alert scheduling, and current-month status is anchored to the real current calendar month.
- **CSV rides in the job payload.** Fine for the assessment's file sizes; very large files would warrant streaming from object storage instead of carrying the text through Redis.
- **Receipts (if built) would be process-and-discard.** The image yields a transaction; no object storage is in scope, so the image itself wouldn't be retained.
- **~6-hour build window.** Scope was chosen to make the product loop and the scale story real and tested, rather than to surface every feature half-built.

---

## Testing

```bash
pnpm -w test        # all unit suites
pnpm -w typecheck   # tsc across every package (0 errors)
pnpm -w build       # tsc builds + a Vite production build of the web app
```

Unit tests across the workspace focus on the logic that has to be correct:

- **CSV parse + dedupe** (`packages/contracts`): duplicate/missing/malformed classification, sign preservation, stable hashing (same inputs ⇒ same hash; different amount or user ⇒ different hash).
- **Rollup math** (`packages/contracts`): baseline average, percent delta, and `null` delta when the baseline is zero.
- **Recurring and unusual-charge heuristics** (`packages/contracts`): stable monthly cadence, one skipped billing cycle, sparse repeat rejection, category-median outliers, large one-offs, sparse-rent exclusion, and income exclusion.
- **Tool handlers** (`apps/api`): every query is **scoped to `userId`**; `get_data_status` reports imported data coverage; `query_spending` filters `amount < 0` and returns a positive total (income does not offset spending); `list_transactions` caps `limit` at 50 and "biggest purchase" excludes income; `compare_periods` reads `DailyRollup` (not raw rows); `compare_spending_ranges` uses exact named windows; `explain_spending_change` returns category/merchant drivers; subscriptions, unusual charges, and budgets are scoped and bounded; user-fact writes carry `userId`.
- **Model routing** (`packages/ai`): dev chat → local provider, prod chat → Groq gpt-oss, vision → multimodal.
- **Cost calculation** (`packages/ai`): pricing per model and provider-tolerant usage normalization.
- **Web util + env loader** smoke tests.

These tests are where multi-tenant isolation is guarded (in lieu of Postgres RLS) and where the sign convention is pinned down.

The **live end-to-end chat** is not unit-tested — it needs a real model endpoint (a local OpenAI-compatible server for `dev`, or a `GROQ_API_KEY` for `prod`). Verify it manually via the web app once `pnpm dev` is up.
