import { periodDelta } from './rollups';

describe('periodDelta', () => {
  it('computes percent change vs baseline average', () => {
    const r = periodDelta({ current: 300, baselineMonths: [200, 200, 200] });
    expect(r.baseline).toBe(200);
    expect(r.deltaPct).toBeCloseTo(50);
  });

  it('handles zero baseline without dividing by zero', () => {
    expect(periodDelta({ current: 100, baselineMonths: [0, 0] }).deltaPct).toBeNull();
  });

  it('empty baseline yields null delta', () => {
    expect(periodDelta({ current: 100, baselineMonths: [] }).deltaPct).toBeNull();
  });
});
