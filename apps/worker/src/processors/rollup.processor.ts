import { Injectable, Logger } from '@nestjs/common';
import type { RollupRebuildPayload } from '@walletwise/contracts';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Consumes `JOBS.ROLLUP_REBUILD`: idempotently rebuild the user's
 * `MonthlyRollup` rows from their raw `Transaction` rows. Rollups are the
 * scale lever (design spec §9) — `compare_periods` reads `MonthlyRollup`
 * ONLY, never raw transactions — so they must always reflect the current
 * truth for the user.
 *
 * The rebuild is a full DELETE + INSERT for that one user inside a single
 * `$transaction`, which makes it idempotent: running it again (e.g. a BullMQ
 * retry, or back-to-back imports) converges to the same rows rather than
 * double-counting. It is scoped to a single `userId`, so it never touches
 * another user's rollups.
 *
 * Sign convention (spec §9): spending is `amount < 0`; `MonthlyRollup
 * .totalAmount` is the POSITIVE spend total, i.e. `SUM(ABS("amount"))`. Income
 * (`amount >= 0`) is excluded by the `"amount" < 0` filter. `month` is the
 * first instant of the month in UTC via `date_trunc('month', "postedAt")`, and
 * a NULL category collapses to `'uncategorized'`.
 *
 * Identifiers are written with the Prisma default mapping (no `@map` on the
 * models), confirmed against the generated migration
 * (infra/db/prisma/migrations/20260604222818_init/migration.sql): the table is
 * `"MonthlyRollup"` / `"Transaction"` and the columns are `"userId"`,
 * `"month"`, `"category"`, `"txnCount"`, `"totalAmount"`, `"postedAt"`,
 * `"amount"`.
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
    // of rolled-up (month, category) rows.
    const [, inserted] = await this.prisma.$transaction([
      this.prisma.$executeRaw`DELETE FROM "MonthlyRollup" WHERE "userId" = ${userId}`,
      this.prisma.$executeRaw`
        INSERT INTO "MonthlyRollup" ("userId","month","category","txnCount","totalAmount")
        SELECT "userId", date_trunc('month', "postedAt") AS month,
               COALESCE("category",'uncategorized') AS category,
               COUNT(*)::int, SUM(ABS("amount"))
        FROM "Transaction"
        WHERE "userId" = ${userId} AND "amount" < 0
        GROUP BY "userId", date_trunc('month', "postedAt"), COALESCE("category",'uncategorized')
      `,
    ]);

    this.log.log(`rollup rebuild user=${userId} rows=${inserted}`);
  }
}
