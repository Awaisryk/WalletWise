import { detectRecurringCharges, normalizeMerchant } from './recurring';

function txn(merchant: string, amount: number, isoDate: string) {
  return { merchant, amount, postedAt: new Date(isoDate + 'T00:00:00Z') };
}

describe('normalizeMerchant', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeMerchant('  Netflix  Inc ')).toBe('netflix inc');
  });
});

describe('detectRecurringCharges', () => {
  it('detects a monthly subscription with stable amounts', () => {
    const txns = [
      txn('Netflix', -15.99, '2026-01-05'),
      txn('Netflix', -15.99, '2026-02-04'),
      txn('Netflix', -15.99, '2026-03-06'),
      // noise: a one-off purchase
      txn('Best Buy', -420, '2026-02-10'),
    ];
    const r = detectRecurringCharges(txns);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      merchant: 'Netflix',
      cadence: 'monthly',
      typicalAmount: 15.99,
      occurrences: 3,
      firstCharge: '2026-01-05',
      lastCharge: '2026-03-06',
    });
  });

  it('detects a monthly subscription with one skipped billing cycle', () => {
    const txns = [
      txn('Spotify', -14.99, '2026-02-10'),
      txn('Spotify', -14.99, '2026-04-09'),
      txn('Spotify', -14.99, '2026-05-09'),
    ];
    const r = detectRecurringCharges(txns);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      merchant: 'Spotify',
      cadence: 'monthly',
      typicalAmount: 14.99,
      occurrences: 3,
    });
  });

  it('does not treat very sparse repeats as monthly cadence', () => {
    const txns = [
      txn('Tesco', -85.2, '2026-01-05'),
      txn('Tesco', -75.3, '2026-04-02'),
      txn('Tesco', -88.4, '2026-05-03'),
    ];
    expect(detectRecurringCharges(txns)).toHaveLength(0);
  });

  it('ignores merchants with too few charges', () => {
    const txns = [txn('Spotify', -9.99, '2026-01-01'), txn('Spotify', -9.99, '2026-02-01')];
    expect(detectRecurringCharges(txns)).toHaveLength(0);
  });

  it('ignores repeats with unstable amounts (e.g. a grocery store)', () => {
    const txns = [
      txn('Tesco', -12, '2026-01-03'),
      txn('Tesco', -85, '2026-02-02'),
      txn('Tesco', -40, '2026-03-04'),
    ];
    expect(detectRecurringCharges(txns)).toHaveLength(0);
  });

  it('ignores stable amounts that are not on a recurring cadence', () => {
    // Same amount but random spacing (3 days, then 90) -> no cadence.
    const txns = [
      txn('Coffee', -5, '2026-01-01'),
      txn('Coffee', -5, '2026-01-04'),
      txn('Coffee', -5, '2026-04-04'),
    ];
    expect(detectRecurringCharges(txns)).toHaveLength(0);
  });

  it('groups by normalized merchant regardless of case/spacing', () => {
    const txns = [
      txn('NETFLIX', -15.99, '2026-01-05'),
      txn('netflix', -15.99, '2026-02-04'),
      txn('Netflix ', -15.99, '2026-03-06'),
    ];
    expect(detectRecurringCharges(txns)).toHaveLength(1);
  });
});
