import { Injectable, Logger } from '@nestjs/common';
import type { RollupRebuildPayload } from '@walletwise/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Consumes `JOBS.ROLLUP_REBUILD`: idempotently rebuild the user's `DailyRollup`
 * rows from their raw `Transaction` rows. Rollups are the scale lever (design
 * spec §9) — `compare_periods` reads `DailyRollup` ONLY, never raw transactions
 * — so they must always reflect the current truth for the user.
 *
 * Grain is DAILY: weekly / monthly / yearly comparisons are derived later by
 * bucketing days in `compare_periods`, which keeps the schema flexible while
 * the read stays pre-aggregated.
 *
 * The rebuild is a full DELETE + INSERT for that one user inside a single
 * `$transaction`, which makes it idempotent: running it again (e.g. a BullMQ
 * retry, or back-to-back imports) converges to the same rows rather than
 * double-counting. It is scoped to a single `userId`, so it never touches
 * another user's rollups.
 *
 * Sign convention (spec §9): spending is `amount < 0`; `DailyRollup.totalAmount`
 * is the POSITIVE spend total, i.e. `SUM(ABS("amount"))`. Income (`amount >= 0`)
 * is excluded by the `"amount" < 0` filter. `day` is the first instant of the
 * day in UTC via `date_trunc('day', "postedAt")`, and a NULL category collapses
 * to `'uncategorized'`.
 *
 * Identifiers use the Prisma default mapping (no `@map` on the models): the
 * table is `"DailyRollup"` / `"Transaction"` and the columns are `"userId"`,
 * `"day"`, `"category"`, `"txnCount"`, `"totalAmount"`, `"postedAt"`, `"amount"`.
 */
@Injectable()
export class RollupProcessor {
  private readonly log = new Logger(RollupProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(payload: RollupRebuildPayload): Promise<void> {
    const { userId } = payload;

    // Single transaction: wipe this user's rollups, then re-aggregate from the
    // raw transactions. `${userId}` is bound as a parameter (not string
    // interpolation), so this is injection-safe. The INSERT returns the number
    // of rolled-up (day, category) rows.
    const [, inserted] = await this.prisma.$transaction([
      this.prisma.$executeRaw`DELETE FROM "DailyRollup" WHERE "userId" = ${userId}`,
      this.prisma.$executeRaw`
        INSERT INTO "DailyRollup" ("userId","day","category","txnCount","totalAmount")
        SELECT "userId", date_trunc('day', "postedAt") AS day,
               COALESCE("category",'uncategorized') AS category,
               COUNT(*)::int, SUM(ABS("amount"))
        FROM "Transaction"
        WHERE "userId" = ${userId} AND "amount" < 0
        GROUP BY "userId", date_trunc('day', "postedAt"), COALESCE("category",'uncategorized')
      `,
    ]);

    this.log.log(`rollup rebuild user=${userId} rows=${inserted}`);
  }
}
