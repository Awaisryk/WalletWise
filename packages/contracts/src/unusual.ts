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

export interface LargeOneOffCharge {
  id?: string;
  merchant: string;
  category: string;
  amount: number; // positive dollars
  postedAt: string; // YYYY-MM-DD
  /** How many charges exist in this category inside the scanned window. */
  categoryTxnCount: number;
  /** Median charge across all scanned spending, used when category history is sparse. */
  globalMedian: number;
  /** How many times the global median this charge is, rounded to 1 dp. */
  timesGlobalMedian: number | null;
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

export interface LargeOneOffOptions {
  /** Consider categories with this many or fewer charges as sparse. Default 1. */
  maxCategorySize?: number;
  /** Ignore charges below this dollar floor. Default 100. */
  floor?: number;
  /** Require the charge to be at least this multiple of the global median. Default 3. */
  multiple?: number;
  /** Cap on how many one-offs to return (largest first). Default 5. */
  limit?: number;
  /** Categories that are expected to be large/regular and should not be called one-offs. */
  excludeCategories?: string[];
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

/**
 * Find large charges in categories with too little history for a per-category
 * median. These are not "unusual vs category median"; they are separate
 * large one-offs worth surfacing because a strict median rule would otherwise
 * hide new-category spikes.
 */
export function detectLargeOneOffCharges(
  txns: UnusualInputTxn[],
  opts: LargeOneOffOptions = {},
): LargeOneOffCharge[] {
  const maxCategorySize = opts.maxCategorySize ?? 1;
  const floor = opts.floor ?? 100;
  const multiple = opts.multiple ?? 3;
  const limit = opts.limit ?? 5;
  const excluded = new Set((opts.excludeCategories ?? ['rent', 'mortgage']).map((c) => c.toLowerCase()));

  const spending = txns.filter((t) => t.amount < 0);
  const globalMedian = Math.round(median(spending.map((t) => Math.abs(t.amount))) * 100) / 100;
  if (spending.length === 0) return [];

  const categoryCounts = new Map<string, number>();
  for (const t of spending) {
    const category = t.category ?? 'uncategorized';
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }

  const out: LargeOneOffCharge[] = [];
  for (const t of spending) {
    const category = t.category ?? 'uncategorized';
    if (excluded.has(category.toLowerCase())) continue;

    const amount = Math.abs(t.amount);
    const categoryTxnCount = categoryCounts.get(category) ?? 0;
    if (categoryTxnCount > maxCategorySize) continue;
    if (amount < floor) continue;
    if (globalMedian > 0 && amount < globalMedian * multiple) continue;

    out.push({
      ...(t.id ? { id: t.id } : {}),
      merchant: t.merchant.trim(),
      category,
      amount: Math.round(amount * 100) / 100,
      postedAt: ymd(t.postedAt),
      categoryTxnCount,
      globalMedian,
      timesGlobalMedian: globalMedian > 0 ? Math.round((amount / globalMedian) * 10) / 10 : null,
    });
  }

  return out.sort((a, b) => b.amount - a.amount).slice(0, limit);
}
