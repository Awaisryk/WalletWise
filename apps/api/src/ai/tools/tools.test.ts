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
  // Two months for the same category, newest-first (matches the tool's
  // orderBy: { month: 'desc' }). `totalAmount` is a positive spend total.
  const rollupFindMany = jest.fn(async () => [
    { userId: 'u1', month: new Date('2026-05-01T00:00:00Z'), category: 'groceries', txnCount: 4, totalAmount: 300 },
    { userId: 'u1', month: new Date('2026-04-01T00:00:00Z'), category: 'groceries', txnCount: 3, totalAmount: 200 },
  ]);
  const prisma: any = {
    transaction: { aggregate, findMany },
    userFact: { create: factCreate, findMany: factFindMany },
    monthlyRollup: { findMany: rollupFindMany },
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
        where: expect.objectContaining({ userId: 'u1', amount: { lt: 0 }, category: 'groceries' }),
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

  it('compare_periods reads MonthlyRollup scoped to userId and returns periodDelta', async () => {
    const { prisma, rollupFindMany } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.compare_periods.execute({ category: 'groceries' }, {} as any);

    // Reads rollups only, scoped by userId, with the category filter applied.
    expect(rollupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', category: 'groceries' }),
        orderBy: { month: 'desc' },
      }),
    );

    // current = newest month (300); baseline = trailing month(s) avg (200).
    const expected = periodDelta({ current: 300, baselineMonths: [200] });
    expect(r.current).toBe(expected.current);
    expect(r.baseline).toBe(expected.baseline);
    expect(r.deltaPct).toBeCloseTo(expected.deltaPct as number);
    expect(r.deltaPct).toBeCloseTo(50);
    expect(r.currentMonth).toBe('2026-05-01T00:00:00.000Z');
  });

  it('compare_periods returns a no-data result when there are no rollups', async () => {
    const { prisma, rollupFindMany } = makePrisma();
    rollupFindMany.mockResolvedValueOnce([]);
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.compare_periods.execute({}, {} as any);
    expect(rollupFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'u1' }) }),
    );
    expect(r).toEqual({ current: 0, baseline: 0, deltaPct: null, note: 'no rollup data yet' });
  });
});
