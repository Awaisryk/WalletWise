import { z } from 'zod';
import type { Tool } from 'ai';
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
}: {
  prisma: PrismaService;
  userId: string;
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
            ...(category ? { category } : {}),
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
            ...(category ? { category } : {}),
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
     * Current period vs baseline. Stub for now — the real implementation reads
     * MonthlyRollup in Phase 5.
     */
    compare_periods: createTool({
      name: 'compare_periods',
      description:
        'Compare spending in a current period against a baseline period (e.g. this month vs the trailing average). Reads precomputed monthly rollups.',
      inputSchema: z.object({
        category: z.string().optional(),
        period: z.string().optional(),
        baseline: z.string().optional(),
      }),
      execute: async () => {
        return { note: 'implemented in Phase 5', ignoreLog: true };
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
