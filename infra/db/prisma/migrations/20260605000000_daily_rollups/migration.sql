-- Replace the monthly rollup grain with a daily grain. Weekly/monthly/yearly
-- comparison views are now derived in application code (compare_periods) by
-- bucketing days, which keeps the schema flexible. Rollups are derived data
-- (rebuilt by the worker from raw transactions), so dropping the old table is
-- safe — no source-of-truth is lost.

-- DropTable
DROP TABLE "MonthlyRollup";

-- CreateTable
CREATE TABLE "DailyRollup" (
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "category" TEXT NOT NULL,
    "txnCount" INTEGER NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "DailyRollup_pkey" PRIMARY KEY ("userId","day","category")
);
