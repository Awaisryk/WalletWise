/**
 * BullMQ queue contract shared by the API (producer) and the worker
 * (consumer). The queue name and job names live here so neither side can
 * drift from the other — renaming `WALLETWISE_QUEUE` or a `JOBS` entry is a
 * single-source-of-truth change.
 */

/** Single BullMQ queue all WalletWise background work flows through. */
export const WALLETWISE_QUEUE = 'walletwise';

/**
 * Job names (BullMQ `job.name`). The worker's dispatcher switches on these.
 * `RECEIPT_OCR` is a stretch contract only — the worker throws "not
 * implemented" for it in this phase.
 */
export const JOBS = {
  IMPORT_CSV: 'import.csv',
  ROLLUP_REBUILD: 'rollup.rebuild',
  RECEIPT_OCR: 'receipt.ocr',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Payload for `JOBS.IMPORT_CSV`. The worker parses `csv` and writes rows scoped to `userId`. */
export interface ImportCsvPayload {
  userId: string;
  importJobId: string;
  csv: string;
}

/** Payload for `JOBS.ROLLUP_REBUILD`. `month` is `YYYY-MM`; omit to rebuild all months. */
export interface RollupRebuildPayload {
  userId: string;
  month?: string;
}

/** Payload for `JOBS.RECEIPT_OCR` (stretch). */
export interface ReceiptOcrPayload {
  userId: string;
  imageBase64: string;
  mimeType: string;
}
