// Mock the Redis-backed tool-call logger so tool execution never touches a real
// Redis instance during unit tests. The wrapper imports `redisClient` from the
// redis service; stub its methods to no-ops.
jest.mock('../../redis/redis.service', () => ({
  redisClient: {
    get: jest.fn(async () => null),
    setEx: jest.fn(async () => undefined),
  },
}));

import { periodDelta } from '@walletwise/contracts';
import { buildTools } from './index';

function makePrisma() {
  const aggregate = jest.fn(async (args?: any) => {
    if (args?._min || args?._max) {
      return {
        _count: 45,
        _min: { postedAt: new Date('2026-01-05T00:00:00Z') },
        _max: { postedAt: new Date('2026-05-25T00:00:00Z') },
      };
    }
    return { _sum: { amount: -42.5 }, _count: 3 };
  });
  const count = jest.fn(async (args?: any) => {
    if (args?.where?.amount?.lt === 0) return 40;
    if (args?.where?.amount?.gt === 0) return 5;
    return 45;
  });
  const findMany = jest.fn(async () => [
    { id: 't1', postedAt: new Date('2026-03-15T00:00:00Z'), merchantRaw: 'X', amount: -10, category: 'groceries' },
  ]);
  // groupBy(category) for get_spending_breakdown — deliberately out of total order
  // and with a null category so the tool's sort + 'uncategorized' coalesce are exercised.
  const groupBy = jest.fn(async () => [
    { category: 'groceries', _sum: { amount: -300 }, _count: 8 },
    { category: 'rent', _sum: { amount: -1200 }, _count: 1 },
    { category: null, _sum: { amount: -100 }, _count: 2 },
  ]);
  const factCreate = jest.fn(async () => ({}));
  const factFindMany = jest.fn(async () => [
    { key: 'payday', value: '1st', kind: 'income' },
  ]);
  // Daily rollups, newest-first (matches the tool's orderBy: { day: 'desc' }).
  // `totalAmount` is a positive spend total. These days bucket into May 2026
  // (180 + 120 = 300) and April 2026 (200) for the default monthly granularity.
  const rollupFindMany = jest.fn(async () => [
    { day: new Date('2026-05-20T00:00:00Z'), totalAmount: 180 },
    { day: new Date('2026-05-05T00:00:00Z'), totalAmount: 120 },
    { day: new Date('2026-04-10T00:00:00Z'), totalAmount: 200 },
  ]);
  const budgetUpsert = jest.fn(async () => ({}));
  const budgetFindMany = jest.fn(async () => [
    { category: 'dining', monthlyLimit: 300 },
  ]);
  const prisma: any = {
    transaction: { aggregate, count, findMany, groupBy },
    userFact: { create: factCreate, findMany: factFindMany },
    dailyRollup: { findMany: rollupFindMany },
    budget: { upsert: budgetUpsert, findMany: budgetFindMany },
  };
  return {
    prisma,
    aggregate,
    count,
    findMany,
    groupBy,
    factCreate,
    factFindMany,
    rollupFindMany,
    budgetUpsert,
    budgetFindMany,
  };
}

describe('buildTools', () => {
  it('get_data_status reports imported transaction coverage for the current user', async () => {
    const { prisma, count, aggregate } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.get_data_status.execute({}, {} as any);

    expect(count).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(count).toHaveBeenCalledWith({ where: { userId: 'u1', amount: { lt: 0 } } });
    expect(count).toHaveBeenCalledWith({ where: { userId: 'u1', amount: { gt: 0 } } });
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1' },
        _min: { postedAt: true },
        _max: { postedAt: true },
      }),
    );
    expect(r).toEqual({
      hasData: true,
      transactionCount: 45,
      spendingTransactionCount: 40,
      incomeTransactionCount: 5,
      firstTransactionDate: '2026-01-05',
      lastTransactionDate: '2026-05-25',
      categories: ['groceries'],
    });
  });

  it('get_spending_breakdown groups by category (userId + amount<0), sorts by total desc, adds shares', async () => {
    const { prisma, groupBy } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.get_spending_breakdown.execute({ from: '2026-03-01', to: '2026-04-01' }, {} as any);

    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['category'],
        where: expect.objectContaining({ userId: 'u1', amount: { lt: 0 } }),
      }),
    );
    // total = 300 + 1200 + 100 = 1600; sorted largest first; null -> uncategorized.
    expect(r.totalSpend).toBe(1600);
    expect(r.categoryCount).toBe(3);
    expect(r.categories.map((c: any) => c.category)).toEqual(['rent', 'groceries', 'uncategorized']);
    expect(r.categories[0]).toMatchObject({ category: 'rent', total: 1200, txnCount: 1, pctOfTotal: 75 });
    expect(r.categories[2]).toMatchObject({ category: 'uncategorized', total: 100 });
  });

  it('compare_spending_ranges compares an explicit month against a Jan-Apr monthly average', async () => {
    const { prisma, aggregate } = makePrisma();
    aggregate
      .mockResolvedValueOnce({ _sum: { amount: -160.7 }, _count: 2 })
      .mockResolvedValueOnce({ _sum: { amount: -530.3 }, _count: 8 });
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-06-05T00:00:00Z') });
    const r: any = await tools.compare_spending_ranges.execute(
      {
        currentFrom: '2026-05-01',
        currentTo: '2026-06-01',
        baselineFrom: '2026-01-01',
        baselineTo: '2026-05-01',
        category: 'groceries',
        baselineGrain: 'month',
      },
      {} as any,
    );

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          amount: { lt: 0 },
          category: { equals: 'groceries', mode: 'insensitive' },
        }),
      }),
    );
    expect(r.current).toMatchObject({ total: 160.7, txnCount: 2 });
    expect(r.baseline).toMatchObject({
      total: 530.3,
      txnCount: 8,
      grain: 'month',
      periodCount: 4,
      averagePerPeriod: 132.58,
    });
    expect(r.deltaVsBaselineAverage).toBe(28.13);
    expect(r.deltaPctVsBaselineAverage).toBeCloseTo(21.21);
  });

  it('explain_spending_change returns total, category, and merchant drivers for May vs April', async () => {
    const { prisma, aggregate, groupBy } = makePrisma();
    aggregate
      .mockResolvedValueOnce({ _sum: { amount: -1713.59 }, _count: 8 })
      .mockResolvedValueOnce({ _sum: { amount: -1469.89 }, _count: 8 });
    groupBy
      .mockResolvedValueOnce([
        { category: 'rent', _sum: { amount: -1200 }, _count: 1 },
        { category: 'groceries', _sum: { amount: -160.7 }, _count: 2 },
        { category: 'dining', _sum: { amount: -83.8 }, _count: 2 },
        { category: 'transport', _sum: { amount: -44.1 }, _count: 1 },
        { category: 'subscriptions', _sum: { amount: -14.99 }, _count: 1 },
        { category: 'shopping', _sum: { amount: -210 }, _count: 1 },
      ])
      .mockResolvedValueOnce([
        { category: 'rent', _sum: { amount: -1200 }, _count: 1 },
        { category: 'groceries', _sum: { amount: -137.7 }, _count: 2 },
        { category: 'dining', _sum: { amount: -77.7 }, _count: 3 },
        { category: 'transport', _sum: { amount: -39.5 }, _count: 1 },
        { category: 'subscriptions', _sum: { amount: -14.99 }, _count: 1 },
      ])
      .mockResolvedValueOnce([
        { merchantRaw: 'APPLE STORE', _sum: { amount: -210 }, _count: 1 },
        { merchantRaw: 'TESCO EXTRA', _sum: { amount: -88.4 }, _count: 1 },
      ])
      .mockResolvedValueOnce([{ merchantRaw: 'TESCO EXTRA', _sum: { amount: -75.3 }, _count: 1 }]);
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.explain_spending_change.execute(
      {
        currentFrom: '2026-05-01',
        currentTo: '2026-06-01',
        previousFrom: '2026-04-01',
        previousTo: '2026-05-01',
      },
      {} as any,
    );

    expect(r.current).toMatchObject({ total: 1713.59, txnCount: 8 });
    expect(r.previous).toMatchObject({ total: 1469.89, txnCount: 8 });
    expect(r.delta).toBe(243.7);
    expect(r.deltaPct).toBeCloseTo(16.58);
    expect(r.categoryDrivers[0]).toMatchObject({
      category: 'shopping',
      current: 210,
      previous: 0,
      delta: 210,
      status: 'new',
    });
    expect(r.merchantDrivers[0]).toMatchObject({
      merchant: 'APPLE STORE',
      current: 210,
      previous: 0,
      delta: 210,
      status: 'new',
    });
  });

  it('find_subscriptions scans subscription-category spending and returns likely subscriptions', async () => {
    const { prisma, findMany } = makePrisma();
    // Spotify has one skipped billing cycle; rent is not returned because the
    // tool only scans charges categorized as subscriptions.
    findMany.mockResolvedValueOnce([
      { merchantRaw: 'Spotify', amount: -14.99, postedAt: new Date('2026-02-10T00:00:00Z') },
      { merchantRaw: 'Spotify', amount: -14.99, postedAt: new Date('2026-04-09T00:00:00Z') },
      { merchantRaw: 'Spotify', amount: -14.99, postedAt: new Date('2026-05-09T00:00:00Z') },
    ]);
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-05-15T00:00:00Z') });
    const r: any = await tools.find_subscriptions.execute({ monthsBack: 999 }, {} as any);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          amount: { lt: 0 },
          category: { equals: 'subscriptions', mode: 'insensitive' },
        }),
        orderBy: { postedAt: 'asc' },
      }),
    );
    const call = findMany.mock.calls[0][0] as any;
    expect(call.where.postedAt.gte.toISOString().slice(0, 10)).toBe('2024-05-15');
    expect(r.count).toBe(1);
    expect(r.subscriptions[0]).toMatchObject({ merchant: 'Spotify', cadence: 'monthly', typicalAmount: 14.99 });
    expect(r.estimatedMonthlyTotal).toBe(14.99);
  });

  it('find_unusual_charges scans bounded user spending and returns outliers plus large one-offs', async () => {
    const { prisma, findMany } = makePrisma();
    findMany.mockResolvedValueOnce([
      { id: 'c1', merchantRaw: 'Cafe A', amount: -4, category: 'dining', postedAt: new Date('2026-03-01T00:00:00Z') },
      { id: 'c2', merchantRaw: 'Cafe B', amount: -5, category: 'dining', postedAt: new Date('2026-03-02T00:00:00Z') },
      { id: 'c3', merchantRaw: 'Cafe C', amount: -6, category: 'dining', postedAt: new Date('2026-03-03T00:00:00Z') },
      { id: 'c4', merchantRaw: 'Steakhouse', amount: -120, category: 'dining', postedAt: new Date('2026-03-10T00:00:00Z') },
      { id: 'c5', merchantRaw: 'Apple Store', amount: -210, category: 'shopping', postedAt: new Date('2026-03-11T00:00:00Z') },
    ]);
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-03-20T00:00:00Z') });
    const r: any = await tools.find_unusual_charges.execute({ from: '2025-01-01', limit: 999 }, {} as any);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', amount: { lt: 0 } }),
        orderBy: { postedAt: 'desc' },
      }),
    );
    expect(r.count).toBe(2);
    expect(r.unusualCount).toBe(1);
    expect(r.largeOneOffCount).toBe(1);
    expect(r.unusualCharges[0]).toMatchObject({ id: 'c4', merchant: 'Steakhouse', amount: 120, category: 'dining' });
    expect(r.largeOneOffCharges[0]).toMatchObject({ id: 'c5', merchant: 'Apple Store', amount: 210, category: 'shopping' });
    expect(r.note).toMatch(/clamped/);
  });

  it('set_budget upserts a normalized (lowercased) category scoped to userId', async () => {
    const { prisma, budgetUpsert } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.set_budget.execute({ category: 'Dining', monthlyLimit: 300 }, {} as any);
    expect(budgetUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_category: { userId: 'u1', category: 'dining' } },
        create: { userId: 'u1', category: 'dining', monthlyLimit: 300 },
      }),
    );
    expect(r).toMatchObject({ ok: true, category: 'dining', monthlyLimit: 300 });
  });

  it('get_budget_status compares this month spend to the limit, scoped to userId, with a status', async () => {
    const { prisma, aggregate } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-05-15T00:00:00Z') });
    const r: any = await tools.get_budget_status.execute({}, {} as any);
    // spend aggregate is scoped to userId + amount<0 + the category, within May.
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          amount: { lt: 0 },
          category: { equals: 'dining', mode: 'insensitive' },
        }),
      }),
    );
    expect(r.month).toBe('2026-05');
    // limit 300, spent 42.5 -> remaining 257.5, ~14.2% used, ok.
    expect(r.budgets[0]).toMatchObject({
      category: 'dining',
      limit: 300,
      spent: 42.5,
      remaining: 257.5,
      pctUsed: 14.2,
      status: 'ok',
    });
  });

  it('query_spending scopes to userId and filters amount < 0, returns positive total', async () => {
    const { prisma, aggregate } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.query_spending.execute(
      { from: '2026-03-01', to: '2026-04-01', category: 'groceries' },
      {} as any,
    );
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          amount: { lt: 0 },
          category: { equals: 'groceries', mode: 'insensitive' },
        }),
      }),
    );
    expect(r.total).toBe(42.5);
    expect(r.txnCount).toBe(3);
    expect(r.currency).toBe('USD');
  });

  it('query_spending filters by merchant case-insensitively when provided', async () => {
    const { prisma, aggregate } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    await tools.query_spending.execute({ from: '2026-03-01', to: '2026-04-01', merchant: 'amazon' }, {} as any);
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          amount: { lt: 0 },
          merchantRaw: { contains: 'amazon', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('list_transactions caps limit at 50 and includes userId', async () => {
    const { prisma, findMany } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    await tools.list_transactions.execute(
      { from: '2026-03-01', to: '2026-04-01', limit: 999, sort: 'date_desc' },
      {} as any,
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }), take: 50 }),
    );
  });

  it('list_transactions defaults to 20 rows and orders by postedAt desc', async () => {
    const { prisma, findMany } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.list_transactions.execute({ from: '2026-03-01', to: '2026-04-01' }, {} as any);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, orderBy: { postedAt: 'desc' } }),
    );
    // date_desc must NOT constrain amount sign
    const call = findMany.mock.calls[0][0] as any;
    expect(call.where.amount).toBeUndefined();
    // rows are mapped: merchantRaw -> merchant, amount coerced to number
    expect(r.transactions[0]).toEqual(
      expect.objectContaining({ id: 't1', merchant: 'X', amount: -10, category: 'groceries' }),
    );
  });

  it('list_transactions amount_desc returns largest purchase first and excludes income', async () => {
    const { prisma, findMany } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    await tools.list_transactions.execute(
      { from: '2026-03-01', to: '2026-04-01', sort: 'amount_desc' },
      {} as any,
    );
    // largest purchase = most negative amount first => amount asc, AND amount < 0
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', amount: { lt: 0 } }),
        orderBy: { amount: 'asc' },
      }),
    );
  });

  it('save_user_fact writes with the current userId', async () => {
    const { prisma, factCreate } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.save_user_fact.execute(
      { key: 'payday', value: '1st', kind: 'income' },
      {} as any,
    );
    expect(factCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'u1', key: 'payday', value: '1st', kind: 'income' }),
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('get_user_facts reads facts for the current userId and maps fields', async () => {
    const { prisma, factFindMany } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.get_user_facts.execute({ kind: 'income' }, {} as any);
    expect(factFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', kind: 'income' }),
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(r.facts).toEqual([{ key: 'payday', value: '1st', kind: 'income' }]);
  });

  it('compare_periods reads DailyRollup scoped to userId and buckets days into monthly periods anchored on today', async () => {
    const { prisma, rollupFindMany } = makePrisma();
    // today is in May 2026, so the current month is May.
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-05-25T00:00:00Z') });
    const r: any = await tools.compare_periods.execute({ category: 'groceries' }, {} as any);

    // Reads daily rollups only, scoped by userId, with the category filter applied.
    expect(rollupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          category: { equals: 'groceries', mode: 'insensitive' },
        }),
        orderBy: { day: 'desc' },
      }),
    );

    // current = the May bucket (180+120=300); baseline = the prior April bucket (200).
    const expected = periodDelta({ current: 300, baselineValues: [200] });
    expect(r.current).toBe(expected.current);
    expect(r.baseline).toBe(expected.baseline);
    expect(r.deltaPct).toBeCloseTo(50);
    expect(r.granularity).toBe('month');
    expect(r.currentPeriod).toBe('2026-05');
    expect(r.currentPeriodHasData).toBe(true);
  });

  it('compare_periods anchors "current" to today and reports 0 when the current period has no data', async () => {
    // today is in June 2026, but the mock data only has May + April rollups, so
    // the CURRENT month (June) is empty — it must report 0, not silently report
    // May as "current".
    const { prisma } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-06-05T00:00:00Z') });
    const r: any = await tools.compare_periods.execute({}, {} as any);
    expect(r.currentPeriod).toBe('2026-06');
    expect(r.current).toBe(0);
    expect(r.currentPeriodHasData).toBe(false);
    expect(r.note).toMatch(/no spending recorded in the current month/);
    // baseline = the prior months that DO have data (May 300, April 200) => avg 250.
    expect(r.baseline).toBe(250);
    expect(r.deltaPct).toBeCloseTo(-100); // spent nothing vs a 250 baseline
  });

  it('compare_periods supports yearly granularity', async () => {
    const { prisma, rollupFindMany } = makePrisma();
    rollupFindMany.mockResolvedValueOnce([
      { day: new Date('2026-03-01T00:00:00Z'), totalAmount: 500 },
      { day: new Date('2025-08-01T00:00:00Z'), totalAmount: 400 },
    ]);
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-03-15T00:00:00Z') });
    const r: any = await tools.compare_periods.execute({ granularity: 'year' }, {} as any);
    expect(r.granularity).toBe('year');
    expect(r.current).toBe(500); // 2026
    expect(r.baseline).toBe(400); // 2025
    expect(r.currentPeriod).toBe('2026');
  });

  it('compare_periods returns a no-data result when there are no rollups', async () => {
    const { prisma, rollupFindMany } = makePrisma();
    rollupFindMany.mockResolvedValueOnce([]);
    const tools = buildTools({ prisma, userId: 'u1', today: new Date('2026-06-15T00:00:00Z') });
    const r: any = await tools.compare_periods.execute({}, {} as any);
    expect(rollupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }) }),
    );
    expect(r).toEqual({
      current: 0,
      baseline: 0,
      deltaPct: null,
      granularity: 'month',
      currentPeriod: '2026-06',
      currentPeriodHasData: false,
      note: 'no spending recorded in the current month yet',
    });
  });
});
