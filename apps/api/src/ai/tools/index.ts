import { z } from 'zod';
import type { Tool } from 'ai';
import { periodDelta, bucketDailyTotals, currentPeriodKey } from '@walletwise/contracts';
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
