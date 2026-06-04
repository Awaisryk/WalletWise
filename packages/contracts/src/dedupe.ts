import { createHash } from 'node:crypto';
export interface DedupeInput { userId: string; postedAt: string; amount: number; merchantRaw: string; }
export function dedupeHash(i: DedupeInput): string {
  const norm = `${i.userId}|${i.postedAt}|${i.amount.toFixed(2)}|${i.merchantRaw.trim().toUpperCase()}`;
  return createHash('sha256').update(norm).digest('hex');
}
