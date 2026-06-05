import { detectUnusualCharges } from './unusual';

function txn(merchant: string, amount: number, category: string | null, isoDate: string, id?: string) {
  return { merchant, amount, category, postedAt: new Date(isoDate + 'T00:00:00Z'), id };
}

describe('detectUnusualCharges', () => {
  it('flags a charge that is much larger than the category median', () => {
    const txns = [
      txn('Cafe A', -4, 'dining', '2026-03-01'),
      txn('Cafe B', -5, 'dining', '2026-03-02'),
      txn('Cafe C', -6, 'dining', '2026-03-03'),
      txn('Steakhouse', -120, 'dining', '2026-03-10', 't-steak'), // ~24x median
    ];
    const r = detectUnusualCharges(txns);
    expect(r).toHaveLength(1);
    // median of [4,5,6,120] = 5.5; 120 / 5.5 = 21.8x.
    expect(r[0]).toMatchObject({
      id: 't-steak',
      merchant: 'Steakhouse',
      category: 'dining',
      amount: 120,
      categoryMedian: 5.5,
      timesMedian: 21.8,
    });
  });

  it('does not flag normal-sized charges', () => {
    const txns = [
      txn('A', -10, 'transport', '2026-03-01'),
      txn('B', -12, 'transport', '2026-03-02'),
      txn('C', -11, 'transport', '2026-03-03'),
      txn('D', -13, 'transport', '2026-03-04'),
    ];
    expect(detectUnusualCharges(txns)).toHaveLength(0);
  });

  it('ignores categories with too few charges (no stable median)', () => {
    const txns = [txn('Rent', -1200, 'rent', '2026-03-01'), txn('Rent', -1200, 'rent', '2026-04-01')];
    expect(detectUnusualCharges(txns)).toHaveLength(0);
  });

  it('respects the absolute floor (small categories do not produce scary outliers)', () => {
    // median 1, a 5 is 5x but below the $20 floor -> not flagged.
    const txns = [
      txn('A', -1, 'fees', '2026-03-01'),
      txn('B', -1, 'fees', '2026-03-02'),
      txn('C', -1, 'fees', '2026-03-03'),
      txn('D', -5, 'fees', '2026-03-04'),
    ];
    expect(detectUnusualCharges(txns)).toHaveLength(0);
  });

  it('ignores income (positive amounts)', () => {
    const txns = [
      txn('Salary', 5000, 'income', '2026-03-01'),
      txn('Salary', 5000, 'income', '2026-04-01'),
      txn('Bonus', 9000, 'income', '2026-04-15'),
      txn('Salary', 5000, 'income', '2026-05-01'),
    ];
    expect(detectUnusualCharges(txns)).toHaveLength(0);
  });
});
