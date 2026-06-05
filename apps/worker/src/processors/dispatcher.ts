import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { WorkerEnv } from '@walletwise/config';
import {
  JOBS,
  WALLETWISE_QUEUE,
  type ImportCsvPayload,
  type JobName,
  type RollupRebuildPayload,
} from '@walletwise/contracts';
import { WORKER_CONFIG } from '../config/worker-config.module';
import { ImportCsvProcessor } from './import-csv.processor';
import { RollupProcessor } from './rollup.processor';

/**
 * BullMQ Worker for the `WALLETWISE_QUEUE`. We instantiate the Worker manually
 * (instead of `@nestjs/bullmq`'s `@Processor()`) so that:
 *   - the dispatch table is explicit and unit-testable
 *   - we own the ioredis connection (`maxRetriesPerRequest: null` is mandatory
 *     for BullMQ's blocking commands)
 *   - we can drain in-flight jobs on shutdown
 *
 * The retry/backoff/retention policy lives on the *producer* side (the API's
 * JobBus and the worker's JobProducer); the consumer just throws on failure
 * and BullMQ handles the rest.
 */
@Injectable()
export class Dispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(Dispatcher.name);
  private worker?: Worker;
  private connection?: Redis;

  constructor(
    @Inject(WORKER_CONFIG) private readonly env: WorkerEnv,
    private readonly importCsv: ImportCsvProcessor,
    private readonly rollup: RollupProcessor,
  ) {}

  onModuleInit(): void {
    this.connection = new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker(WALLETWISE_QUEUE, (job) => this.dispatch(job), {
      connection: this.connection,
      concurrency: this.env.WORKER_CONCURRENCY,
    });

    this.worker.on('failed', (job, err) => {
      const id = job?.id ?? '<no-id>';
      this.log.error(`job ${id} (${job?.name}) failed: ${err.message}`);
    });
    this.worker.on('completed', (job) => {
      this.log.debug(`job ${job.id} (${job.name}) completed`);
    });

    this.log.log(
      `BullMQ worker listening on queue "${WALLETWISE_QUEUE}" (concurrency=${this.env.WORKER_CONCURRENCY})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.connection?.quit().catch(() => {});
  }

  /**
   * Route a job to its processor by BullMQ name. Kept separate from the Worker
   * wiring so it's unit-testable without spinning up Redis.
   */
  async dispatch(job: Job): Promise<void> {
    const name = job.name as JobName;
    switch (name) {
      case JOBS.IMPORT_CSV:
        await this.importCsv.process(job.data as ImportCsvPayload);
        return;
      case JOBS.ROLLUP_REBUILD:
        await this.rollup.process(job.data as RollupRebuildPayload);
        return;
      case JOBS.RECEIPT_OCR:
        throw new Error('receipt.ocr not implemented (stretch)');
      default:
        throw new Error(`Unknown job: ${String(name)}`);
    }
  }
}
