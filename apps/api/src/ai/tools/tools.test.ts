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
  const aggregate = jest.fn(async () => ({ _sum: { amount: -42.5 }, _count: 3 }));
  const findMany = jest.fn(async () => [
    { id: 't1', postedAt: new Date('2026-03-15T00:00:00Z'), merchantRaw: 'X', amount: -10, category: 'groceries' },
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
  const prisma: any = {
    transaction: { aggregate, findMany },
    userFact: { create: factCreate, findMany: factFindMany },
    dailyRollup: { findMany: rollupFindMany },
  };
  return { prisma, aggregate, findMany, factCreate, factFindMany, rollupFindMany };
}

describe('buildTools', () => {
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
