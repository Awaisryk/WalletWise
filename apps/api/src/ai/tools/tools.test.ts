// Mock the Redis-backed tool-call logger so tool execution never touches a real
// Redis instance during unit tests. The wrapper imports `redisClient` from the
// redis service; stub its methods to no-ops.
jest.mock('../../redis/redis.service', () => ({
  redisClient: {
    get: jest.fn(async () => null),
    setEx: jest.fn(async () => undefined),
  },
}));

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
  const prisma: any = {
    transaction: { aggregate, findMany },
    userFact: { create: factCreate, findMany: factFindMany },
  };
  return { prisma, aggregate, findMany, factCreate, factFindMany };
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

  it('compare_periods is a Phase 5 stub', async () => {
    const { prisma } = makePrisma();
    const tools = buildTools({ prisma, userId: 'u1' });
    const r: any = await tools.compare_periods.execute({ category: 'groceries' }, {} as any);
    expect(r).toEqual({ note: 'implemented in Phase 5' });
  });
});
