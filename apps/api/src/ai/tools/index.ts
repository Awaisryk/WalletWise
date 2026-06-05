import { z } from 'zod';
import type { Tool } from 'ai';
import {
  periodDelta,
  bucketDailyTotals,
  currentPeriodKey,
  detectRecurringCharges,
  detectUnusualCharges,
} from '@walletwise/contracts';
import type { PrismaService } from '../../prisma/prisma.service';
import { createTool } from './tool-wrapper';

/**
 * WalletWise assistant tool catalog.
 *
 * These fixed, typed tools are the entire data-access surface available to the
 * LLM — there is no free-form SQL. Every Prisma query is scoped to the
 * server-side `userId`, which is injected here via closure: the model never
 * supplies an identity parameter, it only provides non-identity inputs (dates,
 * category, merchant, limit). See design spec §0 + §6.
 *
 * Sign convention: spending is stored as `amount < 0`; totals are reported as
 * positive via `Math.abs`. Income (`amount > 0`) must not offset spending, so
 * spending queries explicitly filter `amount: { lt: 0 }`.
 */
export function buildTools({
  prisma,
  userId,
  today = new Date(),
}: {
  prisma: PrismaService;
  userId: string;
  /**
   * "Now", used to anchor `compare_periods`' current period to the real
   * calendar period (UTC) rather than to the most recent period that happens to
   * have data. Server-supplied (never from the LLM); defaults to the wall clock.
   */
  today?: Date;
}): Record<string, Tool> {
  const tools = {
    /**
     * Lightweight data-availability probe. This gives the model a grounded way
     * to answer "do you have my data?" after a refresh without guessing.
     */
    get_data_status: createTool({
      name: 'get_data_status',
      description:
        'Check whether the user has imported transaction data. Returns transaction counts, date coverage, and available spending categories. Use this for questions like "do you have my data?", "what data do you have?", or "is my CSV imported?".',
      inputSchema: z.object({}),
      execute: async () => {
        const [transactionCount, spendingTransactionCount, incomeTransactionCount, bounds, categoryRows] =
          await Promise.all([
            prisma.transaction.count({ where: { userId } }),
            prisma.transaction.count({ where: { userId, amount: { lt: 0 } } }),
            prisma.transaction.count({ where: { userId, amount: { gt: 0 } } }),
            prisma.transaction.aggregate({
              where: { userId },
              _min: { postedAt: true },
              _max: { postedAt: true },
            }),
            prisma.transaction.findMany({
              where: { userId, amount: { lt: 0 }, category: { not: null } },
              distinct: ['category'],
              select: { category: true },
            }),
          ]);

        const categories = categoryRows
          .map((r: any) => r.category)
          .filter((c: unknown): c is string => typeof c === 'string' && c.length > 0)
          .sort();

        return {
          hasData: transactionCount > 0,
          transactionCount,
          spendingTransactionCount,
          incomeTransactionCount,
          firstTransactionDate: bounds._min.postedAt?.toISOString().slice(0, 10) ?? null,
          lastTransactionDate: bounds._max.postedAt?.toISOString().slice(0, 10) ?? null,
          categories,
          inputSummary: {},
        };
      },
    }),

    /**
     * Spend total for a category/merchant over a date range. Aggregates raw
     * transactions with `amount < 0` and reports a positive total. `from` is
     * inclusive, `to` is exclusive.
     */
    query_spending: createTool({
      name: 'query_spending',
      description:
        'Total spending for an optional category and/or merchant over a date range. Dates are ISO; "from" is inclusive and "to" is exclusive. Returns a positive total (spending only — income does not offset it), a transaction count, and the currency.',
      inputSchema: z.object({
        category: z.string().optional(),
        merchant: z.string().optional(),
        from: z.string().describe('ISO date inclusive'),
        to: z.string().describe('ISO date exclusive'),
      }),
      execute: async ({ category, merchant, from, to }) => {
        const result = await prisma.transaction.aggregate({
          where: {
            userId,
            amount: { lt: 0 },
            postedAt: { gte: new Date(from), lt: new Date(to) },
            ...(category ? { category: { equals: category, mode: 'insensitive' as const } } : {}),
            ...(merchant ? { merchantRaw: { contains: merchant, mode: 'insensitive' } } : {}),
          },
          _sum: { amount: true },
          _count: true,
        });
        return {
          total: Math.abs(Number(result._sum.amount ?? 0)),
          txnCount: result._count,
          currency: 'USD',
          inputSummary: { category, merchant, from, to },
        };
      },
    }),

    /**
     * Recent rows or biggest purchases for the user, capped at 50. For
     * `amount_desc` ("biggest purchase") the rows are ordered most-negative
     * first and constrained to `amount < 0` so income is never surfaced as a
     * purchase. For `date_desc` (default) there is no amount-sign filter.
     */
    list_transactions: createTool({
      name: 'list_transactions',
      description:
        'List the user\'s transactions over a date range, optionally filtered by category. sort="date_desc" (default) returns the most recent rows; sort="amount_desc" returns the biggest purchases (largest spend first, income excluded). limit defaults to 20 and is capped at 50.',
      inputSchema: z.object({
        category: z.string().optional(),
        from: z.string(),
        to: z.string(),
        sort: z.enum(['date_desc', 'amount_desc']).optional(),
        limit: z.number().optional(),
      }),
      execute: async ({ category, from, to, sort, limit }) => {
        const take = Math.min(limit ?? 20, 50);
        const amountDesc = sort === 'amount_desc';
        const rows = await prisma.transaction.findMany({
          where: {
            userId,
            postedAt: { gte: new Date(from), lt: new Date(to) },
            ...(category ? { category: { equals: category, mode: 'insensitive' as const } } : {}),
            // "Biggest purchase" must only consider spending, never income.
            ...(amountDesc ? { amount: { lt: 0 } } : {}),
          },
          // amount_desc => largest purchase first => most negative amount first
          // => ascending numeric order. date_desc => newest first.
          orderBy: amountDesc ? { amount: 'asc' } : { postedAt: 'desc' },
          take,
        });
        return {
          transactions: rows.map((t: any) => ({
            id: t.id,
            postedAt: t.postedAt,
            merchant: t.merchantRaw,
            amount: Number(t.amount),
            category: t.category,
          })),
          inputSummary: { category, from, to, sort, limit: take },
        };
      },
    }),

    /**
     * Most-recent-period spend vs the trailing baseline average, at a selectable
     * granularity (week / month / year). Reads precomputed `DailyRollup` rows
     * ONLY (never raw transactions) — the scale lever per spec §9 — scoped to
     * `userId`; `totalAmount` rollups are already positive spend totals
     * (`sum(abs(amount))`).
     *
     * Daily rollups are bucketed into periods (`bucketDailyTotals`) so the same
     * stored grain answers "this week / month / year vs usual". The most recent
     * bucket is `current`; the next `lookback` buckets form the baseline window.
     */
    compare_periods: createTool({
      name: 'compare_periods',
      description:
        'Compare the user\'s most recent period of spending against the trailing baseline average, using precomputed daily rollups (not raw transactions). granularity selects the period size: "week", "month" (default), or "year". Optionally restrict to one category. "lookback" is the number of prior periods in the baseline (default 3). Returns the current-period total, the baseline average, the percent change (deltaPct, null when there is no usable baseline), the granularity, and the current period label.',
      inputSchema: z.object({
        category: z.string().optional(),
        granularity: z.enum(['week', 'month', 'year']).optional(),
        lookback: z.number().optional().describe('baseline window length in periods, default 3'),
      }),
      execute: async ({ category, granularity, lookback }) => {
        const gran = granularity ?? 'month';
        const window = lookback ?? 3;

        // Read this user's daily rollups (optionally one category), newest-first.
        // These are pre-aggregated per (day, category), so even years of history
        // is far smaller than the raw ledger. (For very long histories this read
        // could be date-bounded to the needed window; unbounded is fine here.)
        const rows = await prisma.dailyRollup.findMany({
          where: { userId, ...(category ? { category: { equals: category, mode: 'insensitive' as const } } : {}) },
          orderBy: { day: 'desc' },
          select: { day: true, totalAmount: true },
        });

        const buckets = bucketDailyTotals(
          rows.map((r) => ({ day: r.day, total: Number(r.totalAmount) })),
          gran,
        );

        // Anchor "current" to the REAL calendar period that contains today — not
        // to "the most recent period that has data". Otherwise, asked "am I
        // spending more than usual this month?" on a day when the current month
        // has no spend yet, we'd silently report a past month as "current".
        const currentKey = currentPeriodKey(today, gran);
        const currentBucket = buckets.find((b) => b.key === currentKey);
        const current = currentBucket ? currentBucket.total : 0;

        // Baseline = the periods strictly BEFORE the current one (newest-first),
        // which excludes the current period itself and any future-dated buckets.
        const baselineValues = buckets
          .filter((b) => b.key < currentKey)
          .slice(0, window)
          .map((b) => b.total);
        const d = periodDelta({ current, baselineValues });

        return {
          current: d.current,
          baseline: d.baseline,
          deltaPct: d.deltaPct,
          granularity: gran,
          currentPeriod: currentKey,
          currentPeriodHasData: Boolean(currentBucket),
          ...(currentBucket ? {} : { note: `no spending recorded in the current ${gran} yet` }),
          inputSummary: { category, granularity: gran, lookback: window },
        };
      },
    }),

    /**
     * Per-category spending breakdown over a date range — the grounded basis for
     * "summarize my finances" (#8) and "where can I cut back" (#9). A single
     * `groupBy(category)` over raw spending (`amount < 0`); totals are positive
     * (`abs`), sorted largest-first, with each category's share of the total.
     * The model gets real numbers per category, so any summary or cut-back
     * suggestion is backed by data rather than invented.
     */
    get_spending_breakdown: createTool({
      name: 'get_spending_breakdown',
      description:
        "Break the user's spending down by category over a date range: per-category totals (positive, spending only — income excluded), sorted largest first, each with its share of the total, plus the overall total. Use for \"summarize my spending\", \"where does my money go\", and to ground cut-back suggestions with real numbers. Dates are ISO; from is inclusive, to is exclusive. limit caps how many categories are returned (default 12).",
      inputSchema: z.object({
        from: z.string().describe('ISO date inclusive'),
        to: z.string().describe('ISO date exclusive'),
        limit: z.number().optional(),
      }),
      execute: async ({ from, to, limit }) => {
        const grouped = await prisma.transaction.groupBy({
          by: ['category'],
          where: { userId, amount: { lt: 0 }, postedAt: { gte: new Date(from), lt: new Date(to) } },
          _sum: { amount: true },
          _count: true,
        });
        const categories = grouped
          .map((g: any) => ({
            category: g.category ?? 'uncategorized',
            total: Math.abs(Number(g._sum?.amount ?? 0)),
            txnCount: g._count,
          }))
          .sort((a: { total: number }, b: { total: number }) => b.total - a.total);
        const totalSpend = categories.reduce((sum: number, c: { total: number }) => sum + c.total, 0);
        const take = typeof limit === 'number' ? Math.max(1, limit) : 12;
        const top = categories.slice(0, take).map((c: { category: string; total: number; txnCount: number }) => ({
          ...c,
          pctOfTotal: totalSpend > 0 ? Math.round((c.total / totalSpend) * 1000) / 10 : 0,
        }));
        return {
          from,
          to,
          totalSpend,
          categoryCount: categories.length,
          currency: 'USD',
          categories: top,
          inputSummary: { from, to, limit: take },
        };
      },
    }),

    /**
     * Surface likely recurring subscriptions (#3). Pulls the user's recent
     * spending charges and runs the pure `detectRecurringCharges` heuristic
     * (repeat merchant + steady cadence + stable amount). Results are *likely*
     * subscriptions with supporting evidence, so the assistant can present them
     * with appropriate hedging rather than asserting certainty.
     */
    find_subscriptions: createTool({
      name: 'find_subscriptions',
      description:
        "Find the user's likely recurring subscriptions — merchants that charge them repeatedly at a steady cadence (weekly/monthly/yearly) for a stable amount. Returns each likely subscription with its cadence, typical amount, occurrence count, and first/last charge dates. Use for \"what subscriptions do I have?\", \"am I paying for anything I forgot?\", or recurring-charge questions. These are inferred (likely), so present them as such.",
      inputSchema: z.object({
        monthsBack: z.number().optional().describe('how many months of history to scan, default 12'),
      }),
      execute: async ({ monthsBack }) => {
        const months = monthsBack ?? 12;
        const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, today.getUTCDate()));
        const rows = await prisma.transaction.findMany({
          where: { userId, amount: { lt: 0 }, postedAt: { gte: since } },
          select: { merchantRaw: true, amount: true, postedAt: true },
        });
        const subscriptions = detectRecurringCharges(
          rows.map((r: { merchantRaw: string; amount: unknown; postedAt: Date }) => ({
            merchant: r.merchantRaw,
            amount: Number(r.amount),
            postedAt: r.postedAt,
          })),
        );
        const estimatedMonthly = subscriptions.reduce((sum, s) => {
          const perMonth = s.cadence === 'weekly' ? s.typicalAmount * 4.33 : s.cadence === 'yearly' ? s.typicalAmount / 12 : s.typicalAmount;
          return sum + perMonth;
        }, 0);
        return {
          subscriptions,
          count: subscriptions.length,
          estimatedMonthlyTotal: Math.round(estimatedMonthly * 100) / 100,
          currency: 'USD',
          inputSummary: { monthsBack: months },
        };
      },
    }),

    /**
     * Flag charges that stand out against the user's OWN per-category history
     * (#4). Pulls recent spending and runs the pure `detectUnusualCharges`
     * heuristic (>= N× the category median, above an absolute floor). Each
     * result includes the category median it is compared against, so the
     * assistant frames it as "stands out" with the evidence, not an alarm.
     */
    find_unusual_charges: createTool({
      name: 'find_unusual_charges',
      description:
        "Flag the user's unusual charges — individual charges that are much larger than what they typically spend in that category (compared against their own history). Returns each outlier with its amount, category, the category's median charge, and how many times the median it is. Use for \"any unusual activity?\", \"did anything weird get charged?\", or \"flag big/out-of-pattern charges\". Scans recent history; present results as charges that stand out, with the comparison.",
      inputSchema: z.object({
        from: z.string().optional().describe('ISO date inclusive; defaults to ~90 days ago'),
        to: z.string().optional().describe('ISO date exclusive; defaults to tomorrow'),
        limit: z.number().optional(),
      }),
      execute: async ({ from, to, limit }) => {
        const start = from
          ? new Date(from)
          : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 90));
        const end = to
          ? new Date(to)
          : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
        const rows = await prisma.transaction.findMany({
          where: { userId, amount: { lt: 0 }, postedAt: { gte: start, lt: end } },
          select: { id: true, merchantRaw: true, amount: true, category: true, postedAt: true },
        });
        const unusual = detectUnusualCharges(
          rows.map((r: { id: string; merchantRaw: string; amount: unknown; category: string | null; postedAt: Date }) => ({
            id: r.id,
            merchant: r.merchantRaw,
            amount: Number(r.amount),
            category: r.category,
            postedAt: r.postedAt,
          })),
          { limit: limit ?? 10 },
        );
        return {
          unusualCharges: unusual,
          count: unusual.length,
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
          currency: 'USD',
          inputSummary: { from, to, limit },
        };
      },
    }),

    /**
     * Set (or update) a monthly spending budget for a category (#6). Upserts on
     * the `(userId, category)` unique key so re-setting a category replaces its
     * limit rather than duplicating. `monthlyLimit` is a positive dollar amount.
     */
    set_budget: createTool({
      name: 'set_budget',
      description:
        "Set or update the user's monthly spending budget for a category. monthlyLimit is a positive dollar amount (the most they want to spend on that category per month). Re-setting a category replaces its previous limit. Use when the user says e.g. \"set my dining budget to $300\" or \"budget 500 for groceries\".",
      inputSchema: z.object({
        category: z.string(),
        monthlyLimit: z.number().positive(),
      }),
      execute: async ({ category, monthlyLimit }) => {
        const normalized = category.trim().toLowerCase();
        await prisma.budget.upsert({
          where: { userId_category: { userId, category: normalized } },
          update: { monthlyLimit },
          create: { userId, category: normalized, monthlyLimit },
        });
        return { ok: true, category: normalized, monthlyLimit, inputSummary: { category: normalized } };
      },
    }),

    /**
     * Budget tracking (#6): compare this calendar month's spend against the
     * user's set limits and warn when close/over. "This month" is anchored on
     * the server-supplied `today` (UTC), and spend is the same `amount < 0`
     * aggregate the other tools use — so the status is grounded, not guessed.
     * status: "ok" (<80%), "warning" (>=80% and <=100%), "over" (>100%).
     */
    get_budget_status: createTool({
      name: 'get_budget_status',
      description:
        "Check the user's budget(s) against this calendar month's actual spending. Optionally restrict to one category. Returns, per budgeted category: the limit, the amount spent so far this month, the amount remaining, the percent used, and a status of ok / warning / over. Use for \"am I within budget?\", \"how's my dining budget?\", or to warn when they are close to a limit.",
      inputSchema: z.object({
        category: z.string().optional(),
      }),
      execute: async ({ category }) => {
        const normalized = category?.trim().toLowerCase();
        const budgets = await prisma.budget.findMany({
          where: { userId, ...(normalized ? { category: normalized } : {}) },
        });
        if (budgets.length === 0) {
          return {
            month: currentPeriodKey(today, 'month'),
            budgets: [],
            note: normalized ? `no budget set for ${normalized}` : 'no budgets set yet',
            inputSummary: { category: normalized },
          };
        }
        // Current calendar month [first-of-month, first-of-next-month) in UTC.
        const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

        const statuses = await Promise.all(
          budgets.map(async (b: { category: string; monthlyLimit: unknown }) => {
            const agg = await prisma.transaction.aggregate({
              where: {
                userId,
                amount: { lt: 0 },
                category: { equals: b.category, mode: 'insensitive' as const },
                postedAt: { gte: monthStart, lt: monthEnd },
              },
              _sum: { amount: true },
            });
            const limit = Number(b.monthlyLimit);
            const spent = Math.abs(Number(agg._sum?.amount ?? 0));
            const remaining = Math.round((limit - spent) * 100) / 100;
            const pctUsed = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0;
            const status = pctUsed > 100 ? 'over' : pctUsed >= 80 ? 'warning' : 'ok';
            return { category: b.category, limit, spent, remaining, pctUsed, status };
          }),
        );
        return {
          month: currentPeriodKey(today, 'month'),
          budgets: statuses.sort((a, b) => b.pctUsed - a.pctUsed),
          inputSummary: { category: normalized },
        };
      },
    }),

    /**
     * Remember a stated fact about the user (income, budget rule, preference).
     */
    save_user_fact: createTool({
      name: 'save_user_fact',
      description:
        'Remember a fact the user stated about themselves so it can be applied in later turns. kind classifies the fact (income, budget_rule, preference, other).',
      inputSchema: z.object({
        key: z.string(),
        value: z.string(),
        kind: z.enum(['income', 'budget_rule', 'preference', 'other']),
      }),
      execute: async ({ key, value, kind }) => {
        await prisma.userFact.create({ data: { userId, key, value, kind } });
        return { ok: true, inputSummary: { key, kind } };
      },
    }),

    /**
     * Retrieve previously remembered facts for the user.
     */
    get_user_facts: createTool({
      name: 'get_user_facts',
      description:
        'Retrieve facts previously remembered about the user, optionally filtered by kind (income, budget_rule, preference, other).',
      inputSchema: z.object({
        kind: z.string().optional(),
      }),
      execute: async ({ kind }) => {
        const rows = await prisma.userFact.findMany({
          where: { userId, ...(kind ? { kind } : {}) },
          orderBy: { createdAt: 'desc' },
        });
        return {
          facts: rows.map((f: any) => ({ key: f.key, value: f.value, kind: f.kind })),
          inputSummary: { kind },
        };
      },
    }),
  };

  return tools as unknown as Record<string, Tool>;
}
