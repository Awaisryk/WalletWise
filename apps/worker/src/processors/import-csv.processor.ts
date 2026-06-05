import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JOBS, parseTransactions, type ImportCsvPayload } from '@walletwise/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { JobProducer } from './job-producer';

/**
 * Consumes `JOBS.IMPORT_CSV`: parse the uploaded CSV, bulk-insert the
 * de-duplicated transactions for the job's user, write an import report back
 * to the `ImportJob` row, then chain a `rollup.rebuild` so the user's monthly
 * aggregates reflect the new rows.
 *
 * Ownership: every parsed row carries the job's `userId` (stamped by
 * `parseTransactions`, never read from the file), and the follow-up rollup is
 * enqueued for that same `userId`.
 */
@Injectable()
export class ImportCsvProcessor {
  private readonly log = new Logger(ImportCsvProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: JobProducer,
  ) {}

  async process(payload: ImportCsvPayload): Promise<void> {
    const { importJobId, userId, csv } = payload;

    // Mark running so a polling client sees progress between pending and done.
    await this.prisma.importJob.update({
      where: { id: importJobId },
      data: { status: 'running' },
    });

    try {
      const { rows, skipped } = parseTransactions(csv, userId);
      const rowsTotal = rows.length + skipped.length;

      // `skipDuplicates` makes this idempotent against the
      // `@@unique([userId, dedupeHash])` constraint, so a retried job (or an
      // overlapping import of the same file) won't double-insert. Decimal
      // columns accept JS numbers on write.
      if (rows.length > 0) {
        await this.prisma.transaction.createMany({
          data: rows.map((r) => ({
            userId: r.userId,
            postedAt: r.postedAt,
            amount: r.amount,
            currency: r.currency,
            merchantRaw: r.merchantRaw,
            category: r.category,
            source: r.source,
            dedupeHash: r.dedupeHash,
          })),
          skipDuplicates: true,
        });
      }

      await this.prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: 'done',
          rowsTotal,
          rowsImported: rows.length,
          rowsSkipped: skipped.length,
          // `skipped` is a typed array; Prisma's `InputJsonValue` needs a cast
          // because a TS interface has no index signature (a known Prisma JSON
          // typing quirk). The shape is plain-serializable, so this is safe.
          report: { skipped } as unknown as Prisma.InputJsonValue,
        },
      });

      this.log.log(
        `import ${importJobId} done user=${userId} total=${rowsTotal} imported=${rows.length} skipped=${skipped.length}`,
      );

      // Rebuild this user's daily rollups now that new rows exist. Enqueued via
      // the worker's own producer (the worker has no access to the API's JobBus).
      await this.producer.enqueue(JOBS.ROLLUP_REBUILD, { userId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`import ${importJobId} failed user=${userId}: ${message}`);

      // Record the failure on the job row, then rethrow so BullMQ marks the
      // job failed and applies the retry/backoff policy.
      await this.prisma.importJob
        .update({
          where: { id: importJobId },
          data: { status: 'failed', report: { error: message } },
        })
        .catch(() => {
          /* best-effort: don't mask the original error if this write fails */
        });

      throw err;
    }
  }
}
