import { parseTransactions } from './csv-import';

const csv = `date,amount,merchant,category,account
2026-03-01,-12.50,Tesco,groceries,checking
2026-03-01,-12.50,Tesco,groceries,checking
2026-03-02,,Shell,transport,checking
junk junk junk
2026-03-03,-5.00,Cafe,dining,checking`;

describe('parseTransactions', () => {
  it('dedupes, skips missing-amount and junk rows', () => {
    const { rows, skipped } = parseTransactions(csv, 'u1');
    expect(rows).toHaveLength(2); // Tesco once + Cafe
    expect(skipped.length).toBe(3); // 1 duplicate + missing amount + junk
  });

  it('classifies each skipped row with its reason', () => {
    const { skipped } = parseTransactions(csv, 'u1');
    const reasons = skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['duplicate', 'malformed', 'missing_field']);
  });

  it('preserves the sign of the amount (spending stays negative)', () => {
    const { rows } = parseTransactions(csv, 'u1');
    expect(rows.every((r) => r.amount < 0)).toBe(true);
    const tesco = rows.find((r) => r.merchantRaw === 'Tesco');
    expect(tesco?.amount).toBe(-12.5);
  });

  it('emits fully-formed ParsedTxn rows scoped to the user', () => {
    const { rows } = parseTransactions(csv, 'u1');
    const cafe = rows.find((r) => r.merchantRaw === 'Cafe');
    expect(cafe).toMatchObject({
      userId: 'u1',
      amount: -5,
      currency: 'USD',
      merchantRaw: 'Cafe',
      category: 'dining',
      source: 'csv',
    });
    expect(cafe?.postedAt).toBeInstanceOf(Date);
    expect(cafe?.postedAt.toISOString().slice(0, 10)).toBe('2026-03-03');
    expect(typeof cafe?.dedupeHash).toBe('string');
    expect(cafe?.dedupeHash).toHaveLength(64);
  });

  it('scopes the dedupe hash per user (same CSV, different user → different hashes)', () => {
    const a = parseTransactions(csv, 'u1');
    const b = parseTransactions(csv, 'u2');
    expect(a.rows[0]?.dedupeHash).not.toBe(b.rows[0]?.dedupeHash);
  });

  it('reports positive (income) amounts as valid rows too', () => {
    const income = `date,amount,merchant,category,account
2026-03-04,2000.00,Employer,income,checking`;
    const { rows, skipped } = parseTransactions(income, 'u1');
    expect(skipped).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(2000);
  });

  it('treats a header-only CSV as zero rows and zero skips', () => {
    const { rows, skipped } = parseTransactions('date,amount,merchant,category,account', 'u1');
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});
