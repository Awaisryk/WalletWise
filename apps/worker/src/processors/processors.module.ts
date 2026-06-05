import { Module } from '@nestjs/common';
import { Dispatcher } from './dispatcher';
import { ImportCsvProcessor } from './import-csv.processor';
import { JobProducer } from './job-producer';
import { RollupProcessor } from './rollup.processor';

/**
 * Wires the BullMQ consumer side: the `Dispatcher` (Worker lifecycle + dispatch
 * table), the per-job processors, and the `JobProducer` (for chaining
 * follow-up jobs). `PrismaService` and `WORKER_CONFIG` come from the global
 * Prisma/config modules.
 */
@Module({
  providers: [Dispatcher, ImportCsvProcessor, RollupProcessor, JobProducer],
})
export class ProcessorsModule {}
