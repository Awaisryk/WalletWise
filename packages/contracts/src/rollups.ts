/**
 * Rollup math shared by the worker (which builds daily rollups) and the API's
 * `compare_periods` tool (which reads them). Pure arithmetic — no Prisma, no
 * I/O — so it's trivially unit-testable and identical on both sides of the wire.
 *
 * Storage grain is DAILY (`DailyRollup`); weekly / monthly / yearly comparison
 * views are derived by bucketing days (`bucketDailyTotals`). Keeping the grain
 * fine and deriving coarser periods in code is what makes the comparison
 * flexible without re-aggregating raw transactions.
 *
 * All spend inputs are POSITIVE totals (the rollup's `totalAmount` convention,
 * `sum(abs(amount))`), so a larger `current` than `baseline` means more
 * spending and yields a positive `deltaPct`.
 */

export interface PeriodDeltaInput {
  /** Spend total for the current period. */
  current: number;
  /** Spend totals for each baseline period (the trailing window). */
  baselineValues: number[];
}

export interface PeriodDeltaResult {
  current: number;
  /** Average of `baselineValues`, or 0 when the window is empty. */
  baseline: number;
  /**
   * Percent change of `current` vs `baseline`. `null` when there is no usable
   * baseline (empty window, or a baseline average of 0) so callers never divide
   * by zero or report a misleading percentage.
   */
  deltaPct: number | null;
}

export function periodDelta({ current, baselineValues }: PeriodDeltaInput): PeriodDeltaResult {
  const baseline = baselineValues.length
    ? baselineValues.reduce((sum, v) => sum + v, 0) / baselineValues.length
    : 0;
  const deltaPct = baseline === 0 ? null : ((current - baseline) / baseline) * 100;
  return { current, baseline, deltaPct };
}

/**
 * Calendar granularity for bucketing daily rollups into comparison periods.
 */
export type Granularity = 'week' | 'month' | 'year';

/** Zero-pads a number to 2 digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The UTC Monday that starts the ISO week containing `date`, as `YYYY-MM-DD`.
 * Used as the sortable key for weekly buckets.
 */
function isoWeekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay: 0=Sun..6=Sat. ISO weeks start Monday, so treat Sunday(0) as 7.
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * A sortable bucket key for `date` at the given granularity (computed in UTC):
 *   - week  -> the week's Monday, `YYYY-MM-DD`
 *   - month -> `YYYY-MM`
 *   - year  -> `YYYY`
 * Lexicographic order of these keys matches chronological order.
 */
export function periodKey(date: Date, granularity: Granularity): string {
  switch (granularity) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'month':
      return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
    case 'week':
      return isoWeekStart(date);
  }
}

/**
 * The period key (see `periodKey`) for the period that CONTAINS `asOf` at the
 * given granularity. Use this to anchor "current" to the real calendar period
 * (from today's date) rather than to "the most recent period that happens to
 * have data" — so a question about "this month" reports 0 when the current
 * month has no spend yet, instead of silently answering a past month.
 */
export function currentPeriodKey(asOf: Date, granularity: Granularity): string {
  return periodKey(asOf, granularity);
}

export interface DailyTotal {
  day: Date;
  total: number;
}

export interface PeriodBucket {
  /** The period key (see `periodKey`). */
  key: string;
  /** Summed spend total for the period. */
  total: number;
}

/**
 * Buckets per-day spend totals into periods of the given granularity, summing
 * `total` within each bucket. Returns buckets sorted newest-first (descending
 * key), so `buckets[0]` is the most recent period and the rest form the
 * trailing baseline window.
 */
export function bucketDailyTotals(rows: DailyTotal[], granularity: Granularity): PeriodBucket[] {
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const key = periodKey(r.day, granularity);
    byKey.set(key, (byKey.get(key) ?? 0) + r.total);
  }
  return [...byKey.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}
