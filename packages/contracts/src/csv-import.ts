import { dedupeHash } from './dedupe';

/**
 * A transaction parsed and validated from a CSV row, ready to insert. Shape
 * mirrors the `Transaction` Prisma model's writable columns. `userId` is
 * stamped from the import job (never read from the CSV), so a malicious or
 * mislabelled file can't write rows for another user. `source` is always
 * `'csv'` here; `currency` defaults to USD for this phase.
 */
export interface ParsedTxn {
  userId: string;
  postedAt: Date;
  amount: number;
  currency: 'USD';
  merchantRaw: string;
  category: string | null;
  source: 'csv';
  dedupeHash: string;
}

/** Why a CSV line didn't produce a row. */
export type SkipReason = 'duplicate' | 'missing_field' | 'malformed';

export interface SkippedRow {
  /** 1-based source line number (line 1 is the header). */
  line: number;
  reason: SkipReason;
}

export interface ParseResult {
  rows: ParsedTxn[];
  skipped: SkippedRow[];
}

/** Expected header columns, in order. */
const COLUMNS = ['date', 'amount', 'merchant', 'category', 'account'] as const;

/**
 * Parse a CSV export into validated, de-duplicated transaction rows.
 *
 * Format: a header line `date,amount,merchant,category,account` followed by
 * one transaction per line. Validation per row:
 *   - must split into exactly {@link COLUMNS}.length fields, else `malformed`
 *   - blank lines → `malformed`
 *   - `date` must parse to a valid Date, else `malformed`
 *   - `amount` must be a finite number (sign preserved: spending is negative,
 *     income positive), else `missing_field` when blank / `malformed` otherwise
 *   - `merchant` must be non-empty, else `missing_field`
 *
 * Surviving rows get a {@link dedupeHash} (scoped to `userId`); a row whose
 * hash was already seen in this file is dropped as `duplicate`. The header is
 * line 1, so the first data row is line 2 — that's what `skipped[].line`
 * reports.
 *
 * The header line itself is not validated beyond being consumed; we key off
 * column *position*, not header names, so a differently-labelled but
 * same-shaped header still parses (and a header that looks like data would be
 * dropped as malformed on its own merits). This is intentionally lenient for
 * the MVP importer.
 */
export function parseTransactions(csv: string, userId: string): ParseResult {
  const rows: ParsedTxn[] = [];
  const skipped: SkippedRow[] = [];
  const seenHashes = new Set<string>();

  // Split on LF, tolerating CRLF line endings. Line numbers are 1-based and
  // include the header so they map straight back to the source file.
  const lines = csv.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = (lines[i] ?? '').replace(/\r$/, '');

    // Line 1 is the header — consume it without emitting a row or a skip.
    if (i === 0) continue;

    // A trailing newline produces a final empty element; ignore it silently
    // rather than counting it as a malformed row.
    if (raw.trim() === '') continue;

    const fields = raw.split(',');
    if (fields.length !== COLUMNS.length) {
      skipped.push({ line: lineNo, reason: 'malformed' });
      continue;
    }

    const [dateStr, amountStr, merchantStr, categoryStr] = fields.map((f) => f.trim());

    // Merchant is required.
    if (!merchantStr) {
      skipped.push({ line: lineNo, reason: 'missing_field' });
      continue;
    }

    // Amount: blank → missing_field; present-but-not-a-finite-number → malformed.
    if (amountStr === '' || amountStr === undefined) {
      skipped.push({ line: lineNo, reason: 'missing_field' });
      continue;
    }
    const amount = Number(amountStr);
    if (!Number.isFinite(amount)) {
      skipped.push({ line: lineNo, reason: 'malformed' });
      continue;
    }

    // Date must parse.
    if (!dateStr) {
      skipped.push({ line: lineNo, reason: 'missing_field' });
      continue;
    }
    const postedAt = new Date(dateStr);
    if (Number.isNaN(postedAt.getTime())) {
      skipped.push({ line: lineNo, reason: 'malformed' });
      continue;
    }

    const category = categoryStr ? categoryStr : null;

    // dedupeHash is computed from the same normalized fields the DB unique
    // constraint keys on. We pass the raw date string so two rows with the
    // same calendar date hash identically regardless of Date's timezone
    // rendering.
    const hash = dedupeHash({
      userId,
      postedAt: dateStr,
      amount,
      merchantRaw: merchantStr,
    });

    if (seenHashes.has(hash)) {
      skipped.push({ line: lineNo, reason: 'duplicate' });
      continue;
    }
    seenHashes.add(hash);

    rows.push({
      userId,
      postedAt,
      amount,
      currency: 'USD',
      merchantRaw: merchantStr,
      category,
      source: 'csv',
      dedupeHash: hash,
    });
  }

  return { rows, skipped };
}
