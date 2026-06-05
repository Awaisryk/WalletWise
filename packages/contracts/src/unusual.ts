/**
 * Unusual-charge detection — pure logic, no Prisma/I/O. The API's
 * `find_unusual_charges` tool feeds it the user's spending transactions over a
 * window and returns the result verbatim.
 *
 * "Unusual" is defined RELATIVE TO THE USER'S OWN HISTORY, per category: a
 * charge is flagged when it is much larger than that category's typical charge
 * (>= `multiple` times the category median, default 3x) and clears a small
 * absolute floor (so a $9 charge in a category whose median is $2 isn't flagged
 * as a scary outlier). Every number returned is real; the tool labels these as
 * charges that "stand out" so the assistant compares rather than alarms.
 */

export interface UnusualInputTxn {
  id?: string;
  merchant: string;
  amount: number; // negative for spending
  category: string | null;
  postedAt: Date;
}

export interface UnusualCharge {
  id?: string;
  merchant: string;
  category: string;
  amount: number; // positive dollars
  postedAt: string; // YYYY-MM-DD
  /** The category's median charge (positive dollars) this charge is compared to. */
  categoryMedian: number;
  /** How many times the category median this charge is, rounded to 1 dp. */
  timesMedian: number;
}

export interface UnusualOptions {
  /** Flag charges >= this multiple of the category median. Default 3. */
  multiple?: number;
  /** Ignore categories with fewer than this many charges (no stable median). Default 4. */
  minCategorySize?: number;
  /** Absolute dollar floor; charges below this are never flagged. Default 20. */
  floor?: number;
  /** Cap on how many outliers to return (largest first). Default 10. */
  limit?: number;
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

/**
 * Find charges that stand out against the user's own per-category history.
 * Income (`amount >= 0`) is ignored. Returns outliers sorted by amount, largest
 * first, capped at `limit`.
 */
export function detectUnusualCharges(
  txns: UnusualInputTxn[],
  opts: UnusualOptions = {},
): UnusualCharge[] {
  const multiple = opts.multiple ?? 3;
  const minCategorySize = opts.minCategorySize ?? 4;
  const floor = opts.floor ?? 20;
  const limit = opts.limit ?? 10;

  // Group spending charges by category.
  const byCategory = new Map<string, UnusualInputTxn[]>();
  for (const t of txns) {
    if (t.amount >= 0) continue; // spending only
    const category = t.category ?? 'uncategorized';
    const arr = byCategory.get(category);
    if (arr) arr.push(t);
    else byCategory.set(category, [t]);
  }

  const out: UnusualCharge[] = [];
  for (const [category, charges] of byCategory.entries()) {
    if (charges.length < minCategorySize) continue;
    const amounts = charges.map((c) => Math.abs(c.amount));
    const med = median(amounts);
    if (med <= 0) continue;

    for (const c of charges) {
      const amt = Math.abs(c.amount);
      if (amt < floor) continue;
      if (amt < med * multiple) continue;
      out.push({
        ...(c.id ? { id: c.id } : {}),
        merchant: c.merchant.trim(),
        category,
        amount: Math.round(amt * 100) / 100,
        postedAt: ymd(c.postedAt),
        categoryMedian: Math.round(med * 100) / 100,
        timesMedian: Math.round((amt / med) * 10) / 10,
      });
    }
  }

  return out.sort((a, b) => b.amount - a.amount).slice(0, limit);
}
