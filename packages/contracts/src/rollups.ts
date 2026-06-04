/**
 * Monthly-rollup delta math, shared by the worker (which builds the rollups)
 * and the API's `compare_periods` tool (which reads them). Pure arithmetic —
 * no Prisma, no I/O — so it's trivially unit-testable and identical on both
 * sides of the wire.
 *
 * All inputs are POSITIVE spend totals (the rollup's `totalAmount` convention,
 * i.e. `sum(abs(amount))`), so a larger `current` than `baseline` is more
 * spending and yields a positive `deltaPct`.
 */
export interface PeriodDeltaInput {
  /** Spend total for the current period. */
  current: number;
  /** Spend totals for each baseline month (the trailing window). */
  baselineMonths: number[];
}

export interface PeriodDeltaResult {
  current: number;
  /** Average of `baselineMonths`, or 0 when the window is empty. */
  baseline: number;
  /**
   * Percent change of `current` vs `baseline`. `null` when there is no usable
   * baseline (empty window, or a baseline average of 0) so callers never divide
   * by zero or report a misleading percentage.
   */
  deltaPct: number | null;
}

export function periodDelta({ current, baselineMonths }: PeriodDeltaInput): PeriodDeltaResult {
  const baseline = baselineMonths.length
    ? baselineMonths.reduce((sum, m) => sum + m, 0) / baselineMonths.length
    : 0;
  const deltaPct = baseline === 0 ? null : ((current - baseline) / baseline) * 100;
  return { current, baseline, deltaPct };
}
