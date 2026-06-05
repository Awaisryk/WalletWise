/**
 * Recurring-charge ("subscription") detection — pure logic, no Prisma/I/O, so
 * it's unit-testable and identical wherever it runs. The API's
 * `find_subscriptions` tool feeds it the user's spending transactions and
 * returns the result verbatim.
 *
 * This is a HEURISTIC: it finds merchants the user is charged by repeatedly, at
 * a roughly fixed cadence, for a roughly stable amount. It deliberately reports
 * results as *likely* subscriptions with the supporting evidence (cadence,
 * typical amount, occurrence count) so the assistant can hedge rather than
 * overclaim — every figure is real, but "this is a subscription" is inferred.
 */

export interface RecurringInputTxn {
  /** Raw merchant string as it appears on the statement. */
  merchant: string;
  /** Spend amount — negative for spending (we use the absolute value). */
  amount: number;
  /** When the charge posted. */
  postedAt: Date;
}

export type Cadence = 'weekly' | 'monthly' | 'yearly';

export interface RecurringCharge {
  merchant: string;
  cadence: Cadence;
  /** Median charge amount (positive dollars). */
  typicalAmount: number;
  /** Number of charges that formed this group. */
  occurrences: number;
  firstCharge: string; // YYYY-MM-DD
  lastCharge: string; // YYYY-MM-DD
}

export interface RecurringOptions {
  /** Minimum number of charges to consider a merchant recurring. Default 3. */
  minOccurrences?: number;
}

/**
 * Cadence windows in days. For weekly/monthly charges we tolerate one missed
 * billing cycle (for example Feb -> Apr -> May) as long as at least one direct
 * interval is observed. That avoids missing common subscriptions while still
 * rejecting sparse, arbitrary repeats.
 */
const CADENCE_WINDOWS: Record<Cadence, Array<{ min: number; max: number; direct: boolean }>> = {
  weekly: [
    { min: 6, max: 8, direct: true },
    { min: 12, max: 16, direct: false },
  ],
  monthly: [
    { min: 26, max: 35, direct: true },
    { min: 52, max: 70, direct: false },
  ],
  yearly: [{ min: 350, max: 380, direct: true }],
};

/** Normalize a merchant string into a grouping key (case/space-insensitive). */
export function normalizeMerchant(merchant: string): string {
  return merchant.trim().toLowerCase().replace(/\s+/g, ' ');
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function classifyCadence(gaps: number[]): Cadence | null {
  if (gaps.length === 0) return null;
  for (const cadence of ['weekly', 'monthly', 'yearly'] as const) {
    let sawDirect = false;
    const matches = gaps.every((gap) => {
      const window = CADENCE_WINDOWS[cadence].find((w) => gap >= w.min && gap <= w.max);
      if (window?.direct) sawDirect = true;
      return Boolean(window);
    });
    if (matches && sawDirect) {
      return cadence;
    }
  }
  return null;
}

/**
 * Detect likely recurring charges. Groups by normalized merchant, then for each
 * group with >= `minOccurrences` charges checks that (a) the median gap between
 * consecutive charges falls in a known cadence window and (b) the amounts are
 * stable (every charge within 20% of the median). Returns the matches sorted by
 * typical amount, largest first.
 */
export function detectRecurringCharges(
  txns: RecurringInputTxn[],
  opts: RecurringOptions = {},
): RecurringCharge[] {
  const minOccurrences = opts.minOccurrences ?? 3;

  const groups = new Map<string, { display: string; txns: RecurringInputTxn[] }>();
  for (const t of txns) {
    const key = normalizeMerchant(t.merchant);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.txns.push(t);
    else groups.set(key, { display: t.merchant.trim(), txns: [t] });
  }

  const out: RecurringCharge[] = [];
  for (const { display, txns: group } of groups.values()) {
    if (group.length < minOccurrences) continue;

    const sorted = [...group].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    const amounts = sorted.map((t) => Math.abs(t.amount));
    const med = median(amounts);
    if (med <= 0) continue;

    // Amount stability: every charge within 20% of the median.
    const stable = amounts.every((a) => Math.abs(a - med) <= med * 0.2);
    if (!stable) continue;

    // Gaps in days between consecutive charges.
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const days = (sorted[i]!.postedAt.getTime() - sorted[i - 1]!.postedAt.getTime()) / 86_400_000;
      gaps.push(days);
    }
    const cadence = classifyCadence(gaps);
    if (!cadence) continue;

    out.push({
      merchant: display,
      cadence,
      typicalAmount: Math.round(med * 100) / 100,
      occurrences: sorted.length,
      firstCharge: ymd(sorted[0]!.postedAt),
      lastCharge: ymd(sorted[sorted.length - 1]!.postedAt),
    });
  }

  return out.sort((a, b) => b.typicalAmount - a.typicalAmount);
}
