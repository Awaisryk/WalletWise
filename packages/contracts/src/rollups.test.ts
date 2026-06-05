import { periodDelta, periodKey, bucketDailyTotals } from './rollups';

describe('periodDelta', () => {
  it('computes percent change vs baseline average', () => {
    const r = periodDelta({ current: 300, baselineValues: [200, 200, 200] });
    expect(r.baseline).toBe(200);
    expect(r.deltaPct).toBeCloseTo(50);
  });

  it('handles zero baseline without dividing by zero', () => {
    expect(periodDelta({ current: 100, baselineValues: [0, 0] }).deltaPct).toBeNull();
  });

  it('empty baseline yields null delta', () => {
    expect(periodDelta({ current: 100, baselineValues: [] }).deltaPct).toBeNull();
  });
});

describe('periodKey', () => {
  it('keys months as YYYY-MM (UTC)', () => {
    expect(periodKey(new Date('2026-05-18T00:00:00Z'), 'month')).toBe('2026-05');
  });

  it('keys years as YYYY', () => {
    expect(periodKey(new Date('2026-05-18T00:00:00Z'), 'year')).toBe('2026');
  });

  it('keys weeks by their ISO Monday', () => {
    // 2026-05-18 is a Monday -> the week start is itself.
    expect(periodKey(new Date('2026-05-18T00:00:00Z'), 'week')).toBe('2026-05-18');
    // 2026-05-20 (Wed) and 2026-05-24 (Sun) belong to the same Mon-start week.
    expect(periodKey(new Date('2026-05-20T00:00:00Z'), 'week')).toBe('2026-05-18');
    expect(periodKey(new Date('2026-05-24T00:00:00Z'), 'week')).toBe('2026-05-18');
  });
});

describe('bucketDailyTotals', () => {
  const rows = [
    { day: new Date('2026-05-20T00:00:00Z'), total: 180 },
    { day: new Date('2026-05-05T00:00:00Z'), total: 120 },
    { day: new Date('2026-04-10T00:00:00Z'), total: 200 },
  ];

  it('sums days into monthly buckets, newest first', () => {
    const b = bucketDailyTotals(rows, 'month');
    expect(b).toEqual([
      { key: '2026-05', total: 300 },
      { key: '2026-04', total: 200 },
    ]);
  });

  it('sums days into yearly buckets', () => {
    const yearRows = [
      { day: new Date('2026-02-01T00:00:00Z'), total: 50 },
      { day: new Date('2025-12-31T00:00:00Z'), total: 70 },
    ];
    expect(bucketDailyTotals(yearRows, 'year')).toEqual([
      { key: '2026', total: 50 },
      { key: '2025', total: 70 },
    ]);
  });
});
